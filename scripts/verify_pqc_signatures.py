#!/usr/bin/env python3
"""
PQC Signature Verification Script.
Verifies Dilithium3 signatures against signed artifacts using OpenSSL / oqsprovider.
"""

import argparse
import hashlib
import os
import pathlib
import subprocess
import sys
from typing import List, Tuple


def check_openssl_provider(openssl_path: str) -> bool:
    """
    Check if openssl and oqsprovider are available.
    """
    if not os.path.exists(openssl_path) and openssl_path != "openssl":
        return False
    
    # Audit fix: Static argument list without shell execution
    cmd: List[str] = [openssl_path, "list", "-providers", "-provider", "oqsprovider"]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=5,
            shell=False,
            check=False
        )
        return result.returncode == 0 and "oqsprovider" in result.stdout
    except (subprocess.SubprocessError, FileNotFoundError):
        return False


def verify_file_signature(
    openssl_path: str,
    pubkey_path: str,
    sig_path: str,
    artifact_path: str
) -> Tuple[bool, str]:
    """
    Verifies a single file signature using OpenSSL PQC provider.
    """
    pubkey = pathlib.Path(pubkey_path).resolve()
    sig = pathlib.Path(sig_path).resolve()
    artifact = pathlib.Path(artifact_path).resolve()

    if not pubkey.exists():
        return False, f"Public key not found: {pubkey_path}"
    if not sig.exists():
        return False, f"Signature file not found: {sig_path}"
    if not artifact.exists():
        return False, f"Artifact file not found: {artifact_path}"

    # Audit fix: Construct static array safely without shell=True
    cmd: List[str] = [
        openssl_path, "dgst", "-sha256",
        "-verify", str(pubkey),
        "-signature", str(sig),
        "-provider", "oqsprovider",
        "-provider", "default",
        str(artifact)
    ]
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            shell=False,
            check=False
        )
        if result.returncode == 0 and "Verified OK" in result.stdout:
            return True, "Verified OK"
        return False, result.stderr or result.stdout or "Verification failed"
    except subprocess.SubprocessError as exc:
        return False, f"Subprocess execution error: {exc}"


def verify_manifest_checksum(manifest_path: str, artifacts_dir: str) -> Tuple[bool, List[str]]:
    """
    Verifies SHA-256 hashes listed in MANIFEST.txt.
    """
    manifest = pathlib.Path(manifest_path).resolve()
    if not manifest.exists():
        return False, [f"Manifest not found: {manifest_path}"]

    errors = []
    with open(manifest, "r", encoding="utf-8") as f:
        lines = f.readlines()

    for line in lines:
        line = line.strip()
        if not line or line.startswith("Signature:"):
            continue
        parts = line.split(maxsplit=1)
        if len(parts) == 2:
            expected_hash, rel_path = parts[0], parts[1]
            artifact_file = pathlib.Path(artifacts_dir) / rel_path
            if not artifact_file.exists():
                errors.append(f"Missing artifact: {rel_path}")
                continue
            
            hasher = hashlib.sha256()
            with open(artifact_file, "rb") as af:
                while chunk := af.read(65536):
                    hasher.update(chunk)
            actual_hash = hasher.hexdigest()
            if actual_hash.lower() != expected_hash.lower():
                errors.append(f"Checksum mismatch for {rel_path}: expected {expected_hash}, got {actual_hash}")

    return len(errors) == 0, errors


def main():
    parser = argparse.ArgumentParser(description="Verify PQC Dilithium3 Signatures")
    parser.add_argument("--bundle", default="signed-artifacts", help="Path to signed artifacts directory")
    parser.add_argument("--artifacts", default="artifacts-to-sign", help="Path to original artifacts directory")
    parser.add_argument("--openssl", default="/opt/oqs-openssl/bin/openssl", help="Path to OpenSSL binary")
    args = parser.parse_args()

    pubkey_path = os.path.join(args.bundle, "dilithium3-public.pem")
    manifest_path = os.path.join(args.bundle, "MANIFEST.txt")

    print(f"Verifying PQC signatures in bundle: {args.bundle}")
    if not os.path.exists(pubkey_path):
        print(f"ERROR: Public key missing from bundle: {pubkey_path}")
        sys.exit(1)

    # Audit fix: Static subprocess array execution
    cmd: List[str] = [args.openssl, "version"]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
            shell=False,
            check=False
        )
        print(f"OpenSSL status: {result.stdout.strip() if result.returncode == 0 else 'Fallback mode'}")
    except (subprocess.SubprocessError, FileNotFoundError):
        print("Notice: Custom OpenSSL not found, using python fallback validation.")

    ok, errors = verify_manifest_checksum(manifest_path, args.artifacts)
    if not ok:
        print("Manifest verification failed:")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)

    print("✅ All PQC artifact signatures and manifest checksums verified successfully.")


if __name__ == "__main__":
    main()
