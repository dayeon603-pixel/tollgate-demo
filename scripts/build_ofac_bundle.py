"""Builds data/ofac_crypto_addresses.json from a Tollgate OFAC primary snapshot.

Usage: python3 scripts/build_ofac_bundle.py <tollgate-yc>/data/ofac_primary data/ofac_crypto_addresses.json

Reads the parsed snapshot, its fetch record in confirmations.jsonl and the raw SDN.XML it came from,
and refuses to write unless the raw file's SHA-256 matches the recorded one. No network access.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import sys
from pathlib import Path

log = logging.getLogger("build_ofac_bundle")


def build(primary: Path, out: Path) -> None:
    """Writes the bundle.

    Args:
        primary: the data/ofac_primary folder of the Tollgate repo.
        out: output JSON path.
    Raises:
        ValueError: when the snapshot, fetch record and raw file disagree.
    """
    snapshots = sorted((primary / "snapshots").glob("sdn_*.json"))
    if len(snapshots) != 1:
        raise ValueError(f"expected one snapshot, found {len(snapshots)}")
    snap = json.loads(snapshots[0].read_text())
    records = [json.loads(line) for line in (primary / "confirmations.jsonl").read_text().splitlines() if line.strip()]
    match = [r for r in records if r["list_digest"] == snap["list_digest"]]
    if len(match) != 1:
        raise ValueError("no unique fetch record for this snapshot")
    fetch = match[0]
    raws = sorted((primary / "raw").glob("SDN_*.xml.gz"))
    if len(raws) != 1:
        raise ValueError(f"expected one raw file, found {len(raws)}")
    raw_sha = hashlib.sha256(gzip.open(raws[0]).read()).hexdigest()
    if raw_sha != fetch["raw_sha256"] or raw_sha != snap["first_raw_sha256"]:
        raise ValueError("raw SDN.XML digest does not match the recorded digest")
    entries = sorted(
        ({"address": e["address"], "chain": e["chain"], "name": e["name"], "uid": e["uid"]} for e in snap["entries"]),
        key=lambda e: (e["address"].lower(), e["chain"], e["uid"]),
    )
    bundle = {
        "source": "OFAC Specially Designated Nationals (SDN) list, digital currency address fields",
        "source_url": fetch["source_url"],
        "publish_date": fetch["publish_date"],
        "fetched_at": fetch["fetched_at"],
        "raw_sha256": raw_sha,
        "list_digest": snap["list_digest"],
        "record_count": snap["record_count"],
        "address_count": snap["address_count"],
        "entries": entries,
    }
    out.write_text(json.dumps(bundle, indent=1, ensure_ascii=False) + "\n")
    log.info("wrote %s: %d entries, %d distinct addresses", out, len(entries), snap["address_count"])


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    build(Path(sys.argv[1]), Path(sys.argv[2]))
