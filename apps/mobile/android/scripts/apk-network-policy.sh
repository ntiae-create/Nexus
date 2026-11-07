#!/usr/bin/env bash
#
# Verifies the network security policy compiled INTO an APK.
#
# Checking the XML files in the repository is not enough: resource merging, source
# sets and the release build type decide what actually ends up in the artifact. This
# script inspects the built APK, so a debug-only policy that leaked into release (or
# a globally permissive base config) fails the build instead of shipping.
#
# Usage:
#   apk-network-policy.sh inspect <apk> <debug|release>
#   apk-network-policy.sh check   <debug|release> <manifest-dump> <config-dump>
#
# `check` reads `aapt2 dump xmltree` output from files, which makes the decision
# logic testable without an Android SDK (see src/test-support/apk-policy-parser.test.ts).
#
set -euo pipefail

# Addresses a debug build may reach over cleartext. Loopback and the emulator's
# host alias only: no LAN range (the platform has no CIDR support) and nothing
# routable on the public internet.
DEBUG_ALLOWED_DOMAINS="10.0.2.2 localhost 127.0.0.1"

# Writes the human-readable report consumed by CI. Called on success and failure,
# so a failure never ends the job without a diagnosis.
write_report() {
  local verdict="$1"
  [[ -n "${DIAGNOSTIC_OUTPUT:-}" ]] || return 0
  {
    printf 'verdict: %s\n' "$verdict"
    if [[ -n "${DIAGNOSTIC_MANIFEST:-}" && -f "${DIAGNOSTIC_MANIFEST}" ]]; then
      printf '\n--- compiled manifest ---\n'
      cat "${DIAGNOSTIC_MANIFEST}"
    fi
    if [[ -n "${DIAGNOSTIC_CONFIG:-}" && -f "${DIAGNOSTIC_CONFIG}" ]]; then
      printf '\n--- compiled network security config ---\n'
      cat "${DIAGNOSTIC_CONFIG}"
    fi
    if [[ -n "${DIAGNOSTIC_NOTE:-}" ]]; then
      printf '\n--- notes ---\n%s\n' "${DIAGNOSTIC_NOTE}"
    fi
  } >"${DIAGNOSTIC_OUTPUT}" 2>&1 || true
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  write_report "FAIL - $*"
  # Printing the compiled dumps turns a CI failure into a diagnosis instead of a
  # mystery: the reviewer sees exactly what the APK contains.
  if [[ -n "${DIAGNOSTIC_MANIFEST:-}" && -f "${DIAGNOSTIC_MANIFEST}" ]]; then
    printf '\n--- compiled manifest ---\n' >&2
    cat "${DIAGNOSTIC_MANIFEST}" >&2 || true
  fi
  if [[ -n "${DIAGNOSTIC_CONFIG:-}" && -f "${DIAGNOSTIC_CONFIG}" ]]; then
    printf '\n--- compiled network security config ---\n' >&2
    cat "${DIAGNOSTIC_CONFIG}" >&2 || true
  fi
  exit 1
}

pass() {
  printf 'ok: %s\n' "$*"
}

# Finds aapt2 from PATH or from the Android SDK build-tools directory.
find_aapt2() {
  if [[ -n "${AAPT2:-}" ]]; then
    printf '%s\n' "$AAPT2"
    return 0
  fi

  if command -v aapt2 >/dev/null 2>&1; then
    command -v aapt2
    return 0
  fi

  local sdk_root candidate
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [[ -n "$sdk_root" && -d "$sdk_root/build-tools" ]] || continue
    candidate="$(find "$sdk_root/build-tools" -maxdepth 2 -name aapt2 -type f | sort -V | tail -1)"
    if [[ -n "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

# Normalizes a compiled boolean attribute.
#
# `aapt2 dump xmltree` may render a boolean either as the literal `true`/`false`
# (when the value came from a string) or as its compiled binary form
# `(type 0x12)0xffffffff` / `(type 0x12)0x0`. Both must be understood, otherwise
# the check would reject a perfectly valid APK.
normalize_bool() {
  local raw
  raw="$(printf '%s' "$1" | tr -d '[:space:]')"
  case "$raw" in
    true|"(type0x12)0xffffffff"|0xffffffff) printf 'true\n' ;;
    false|"(type0x12)0x0"|0x0) printf 'false\n' ;;
    *) printf '%s\n' "$raw" ;;
  esac
}

# Prints the cleartextTrafficPermitted value of the base-config element.
base_cleartext() {
  awk '
    /^[[:space:]]*E: base-config/ { in_base = 1; next }
    in_base && /E: / { in_base = 0 }
    in_base && /A: cleartextTrafficPermitted=/ {
      sub(/.*cleartextTrafficPermitted=/, "")
      print
      exit
    }
  ' "$1" | while IFS= read -r value; do normalize_bool "$value"; done
}

# Prints every `cleartextTrafficPermitted` value found under domain-config blocks.
domain_cleartext_values() {
  awk '
    /^[[:space:]]*E: domain-config/ { in_domain = 1 }
    in_domain && /A: cleartextTrafficPermitted=/ {
      sub(/.*cleartextTrafficPermitted=/, "")
      print
    }
  ' "$1" | while IFS= read -r value; do normalize_bool "$value"; done
}

# Prints one domain per line (the T: '"..."' lines inside domain elements).
listed_domains() {
  awk '
    /^[[:space:]]*E: domain / { in_domain = 1; next }
    in_domain && /^[[:space:]]*T: / {
      line = $0
      sub(/.*T: /, "", line)
      gsub(/["\x27]/, "", line)
      print line
      in_domain = 0
    }
    in_domain && /E: / && !/E: domain / { in_domain = 0 }
  ' "$1"
}

check() {
  local variant="${1:?variant required}" manifest_dump="${2:?manifest dump required}" config_dump="${3:?config dump required}"

  [[ -f "$manifest_dump" ]] || fail "manifest dump not found: $manifest_dump"
  [[ -f "$config_dump" ]] || fail "network security config dump not found: $config_dump"

  DIAGNOSTIC_MANIFEST="$manifest_dump"
  DIAGNOSTIC_CONFIG="$config_dump"

  ########################################
  # Manifest
  ########################################

  # The compiled manifest must point at a network security config resource.
  if ! grep -qE 'android:networkSecurityConfig\(.*\)=@0x[0-9a-fA-F]+' "$manifest_dump"; then
    fail "compiled manifest does not reference @xml/network_security_config"
  fi
  pass "manifest references a network security config resource"

  # usesCleartextTraffic would override the config and open HTTP to every host.
  if grep -qi 'usesCleartextTraffic' "$manifest_dump"; then
    fail "compiled manifest declares usesCleartextTraffic, which opens cleartext globally"
  fi
  pass "manifest does not declare usesCleartextTraffic"

  ########################################
  # Config resource itself
  ########################################

  if ! grep -qE '^[[:space:]]*E: network-security-config' "$config_dump"; then
    fail "compiled resource is not a <network-security-config>"
  fi

  local base
  base="$(base_cleartext "$config_dump")"
  if [[ "$base" != "false" ]]; then
    fail "base-config cleartextTrafficPermitted is '${base:-<missing>}', expected 'false'"
  fi
  pass "base-config denies cleartext for every destination"

  local domain_values domains
  domain_values="$(domain_cleartext_values "$config_dump")"
  domains="$(listed_domains "$config_dump")"

  ########################################
  # Per-variant expectations
  ########################################

  if [[ "$variant" == "release" ]]; then
    # Release must be HTTPS-only: a single domain exception means a debug policy
    # leaked into the artifact.
    if grep -qx 'true' <<<"$domain_values"; then
      fail "release grants a cleartext exception to a domain (debug policy leaked into release)"
    fi
    pass "release declares no cleartext exception"

    if [[ -n "$domains" ]]; then
      fail "release lists cleartext domains: $(tr '\n' ' ' <<<"$domains")"
    fi
    pass "release lists no cleartext domains"

  elif [[ "$variant" == "debug" ]]; then
    if ! grep -qx 'true' <<<"$domain_values"; then
      fail "debug does not grant cleartext to the local development addresses"
    fi
    pass "debug grants cleartext through a domain-config"

    if [[ -z "$domains" ]]; then
      fail "debug domain-config lists no addresses"
    fi

    local domain
    while IFS= read -r domain; do
      [[ -z "$domain" ]] && continue
      if [[ "$domain" == */* ]]; then
        fail "debug lists '${domain}' with CIDR notation, which the platform does not match"
      fi
      if [[ " $DEBUG_ALLOWED_DOMAINS " != *" $domain "* ]]; then
        fail "debug allows cleartext to '${domain}', which is not an approved local address (${DEBUG_ALLOWED_DOMAINS})"
      fi
    done <<<"$domains"
    pass "debug limits cleartext to approved local addresses: $(tr '\n' ' ' <<<"$domains")"

  else
    fail "unknown variant '${variant}' (expected debug or release)"
  fi

  write_report "PASS - $variant APK network policy is correct"
  printf '\nPASS: %s APK network policy is correct\n' "$variant"
}

inspect() {
  local apk="${1:?apk required}" variant="${2:?variant required}"

  # Set first, so even an early failure leaves a report behind for the reviewer.
  DIAGNOSTIC_OUTPUT="${DIAGNOSTIC_OUTPUT:-apk-policy-${variant}.txt}"
  DIAGNOSTIC_NOTE="apk: $apk"
  : >"$DIAGNOSTIC_OUTPUT"

  [[ -f "$apk" ]] || fail "APK not found: $apk"

  local aapt2
  aapt2="$(find_aapt2)" || fail "aapt2 not found (set AAPT2 or install Android build-tools)"
  DIAGNOSTIC_NOTE="apk: $apk
aapt2: $aapt2
aapt2 version: $("$aapt2" version 2>&1 | head -1)"

  local workdir
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT

  local manifest_dump="$workdir/manifest.txt"
  "$aapt2" dump xmltree --file AndroidManifest.xml "$apk" >"$manifest_dump"

  # Locate the compiled network security config. Resource file paths can be
  # renamed, so instead of guessing a name we look for the resource whose root
  # element is <network-security-config>.
  command -v unzip >/dev/null 2>&1 || fail "unzip not found; required to list APK entries"

  local entry candidate config_dump=""
  while IFS= read -r entry; do
    [[ "$entry" == res/*.xml ]] || continue
    candidate="$workdir/entry.xml"
    # Dump to a file instead of piping into `grep -q`: under `set -o pipefail`,
    # grep exiting early sends SIGPIPE to aapt2 and the pipeline reports failure,
    # which would make a present config look absent.
    "$aapt2" dump xmltree --file "$entry" "$apk" >"$candidate" 2>/dev/null || continue
    if grep -qE '^[[:space:]]*E: network-security-config' "$candidate"; then
      if [[ -n "$config_dump" ]]; then
        fail "more than one network security config in the APK ($config_dump and $entry)"
      fi
      config_dump="$workdir/config.txt"
      cp "$candidate" "$config_dump"
      printf 'network security config in APK: %s\n' "$entry"
    fi
  done < <(unzip -Z1 "$apk" 2>/dev/null | grep -E '^res/.*\.xml$' || true)

  [[ -n "$config_dump" ]] || fail "no network security config resource found inside $apk"

  check "$variant" "$manifest_dump" "$config_dump"
}

main() {
  local command="${1:-}"
  case "$command" in
    inspect) shift; inspect "$@" ;;
    check) shift; check "$@" ;;
    *)
      printf 'usage: %s inspect <apk> <debug|release>\n' "$0" >&2
      printf '       %s check   <debug|release> <manifest-dump> <config-dump>\n' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
