#!/usr/bin/env python3
"""Builds data/archive.json and data/proofgap.json from the Tollgate research repos (read only).

Usage: python3 scripts/build_moat_data.py [--yc DIR] [--network DIR] [--out DIR]

Every record keeps the repo-relative path of the file it came from and the SHA-256 of that file, so
tests/moat_data.test.mjs can re-check the bundled JSON against the sources whenever they are on the
machine. Percentages are copied as the report prints them, never recomputed or rounded again.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import re
from pathlib import Path

log = logging.getLogger("build-moat-data")

DEFAULT_YC = Path("~/ventures/tollgate-yc")
DEFAULT_NETWORK = Path("~/ventures/tollgate-network")
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "data"

LIVE = "results/live_proof"
ANCHORING = "results/anchoring"
PROOF_GAP = "results/proof_gap"
SEAL = "results/shared_receipts/real_seal"
PRIMARY = "data/ofac_primary"
MIRROR = "designation_receipts.provenance.json"
FETCH_PATTERN = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) publish (\d{2}/\d{2}/\d{4})")
STREAM_ROW = re.compile(r"^\| (?P<stream>[^|]+) \| (?P<subset>[^|]+) \| (?P<n>\d+) \((?P<designations>\d+)\) \| (?P<a>[^|]+) \| (?P<b>[^|]+) \| (?P<c>[^|]+) \| \*\*(?P<gap>[^|*]+)\*\* \| (?P<m>[^|]+) \|$")


def sha256_file(path: Path) -> str:
    """SHA-256 of a file's bytes, hex."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ref(root: Path, rel: str) -> dict[str, str]:
    """A source reference: repo-relative path and the file's SHA-256."""
    return {"path": rel, "sha256": sha256_file(root / rel)}


def build_postings(yc: Path) -> list[dict]:
    """The OFAC recent-actions pages the watcher saw, each with the anchor that covers its receipt."""
    live = yc / LIVE / "inputs"
    verification = json.loads((live / "anchor_verification.json").read_text())
    rows = [json.loads(line) for line in (live / "ledger.jsonl").read_text().splitlines() if line.strip()]
    out = []
    for row in rows:
        action = row["action"]
        if action["type"] != "ofac_posting_observed":
            continue
        p = action["params"]
        batch = next(b for b in verification if row["seq"] in b["seqs"])
        stem = f"batch_{batch['batch']:05d}"
        bitcoin = sorted(({"height": x["height"], "block_time": x["block_time"]} for x in batch["bitcoin"]), key=lambda x: x["height"])
        unique = [dict(t) for t in {tuple(sorted(x.items())) for x in bitcoin}]
        unique.sort(key=lambda x: x["height"])
        out.append({
            "slug": p["slug"], "url": p["url"], "content_sha256": p["content_sha256"],
            "addresses_listed": len(p["addresses"]), "observed_at": p["observed_at"].replace("+00:00", "Z"),
            "receipt_id": row["receipt_id"], "ledger_seq": row["seq"],
            "anchor": {
                "batch": batch["batch"], "root": batch["root"], "rfc3161_time": batch["tsa_gen_time"],
                "rfc3161_verified": bool(batch.get("tsa_verified")), "inclusion_ok": bool(batch["inclusion_ok"]),
                "bitcoin": unique,
                "ots": ref(yc, f"{LIVE}/inputs/anchors/{stem}.ots"), "tsr": ref(yc, f"{LIVE}/inputs/anchors/{stem}.tsr"),
            },
        })
    return out


def build_snapshot(yc: Path) -> dict:
    """The OFAC SDN publication the demo list is built from."""
    line = (yc / PRIMARY / "confirmations.jsonl").read_text().splitlines()[0]
    c = json.loads(line)
    gz = yc / PRIMARY / "raw" / "SDN_20261027T003948Z.xml.gz"
    return {
        "publish_date": c["publish_date"], "fetched_at": c["fetched_at"], "list_digest": c["list_digest"],
        "raw_sha256": c["raw_sha256"], "raw_xml_gz_sha256_of_decompressed": hashlib.sha256(gzip.decompress(gz.read_bytes())).hexdigest(),
        "source_url": c["source_url"], "source": ref(yc, f"{PRIMARY}/confirmations.jsonl"),
        "snapshot_file": ref(yc, f"{PRIMARY}/snapshots/sdn_{c['list_digest'][:12]}.json"),
        "anchored_independently": False,
    }


def build_fetches(yc: Path) -> dict:
    """SDN.XML fetch times and publish dates the live proof logged, copied from LIVE_PROOF.md."""
    text = (yc / LIVE / "LIVE_PROOF.md").read_text()
    line = next(line for line in text.splitlines() if line.startswith("- SDN.XML fetches:"))
    fetches = [{"fetched_at": t, "publish_date": d} for t, d in FETCH_PATTERN.findall(line)]
    first = {}
    for f in fetches:
        first.setdefault(f["publish_date"], f["fetched_at"])
    return {"fetches": fetches, "first_seen_by_publish_date": first, "source": ref(yc, f"{LIVE}/LIVE_PROOF.md")}


def build_live_summary(yc: Path) -> dict:
    """Counts the live proof reports, from its summary.json."""
    s = json.loads((yc / LIVE / "summary.json").read_text())
    text = (yc / LIVE / "LIVE_PROOF.md").read_text()
    headline = next(line for line in text.splitlines() if line.startswith("**Headline:**")).replace("**Headline:** ", "")
    return {
        "headline": headline, "t0": s["t0"], "t1": s["t1"], "receipts": s["receipts"], "anchored": s["anchored"],
        "bitcoin_confirmed": s["bitcoin_confirmed"], "N": s["N"], "k": s["k"], "M": s["M"],
        "batches": len(json.loads((yc / LIVE / "inputs/anchor_verification.json").read_text())),
        "source": ref(yc, f"{LIVE}/LIVE_PROOF.md"), "summary": ref(yc, f"{LIVE}/summary.json"),
    }


def build_seals(network: Path) -> dict:
    """The two shared-receipt seals the OpenTimestamps upgrade run took to Bitcoin block 974,328."""
    d = json.loads((network / SEAL / "real_seal_upgrade.json").read_text())
    return {
        "checked_at_utc": d["checked_at_utc"],
        "seals": [{k: r[k] for k in ("label", "batch", "root", "state", "bitcoin_height", "block_hash", "header_time", "ok")} for r in d["results"]],
        "source": ref(network, f"{SEAL}/real_seal_upgrade.json"), "requests": ref(network, f"{SEAL}/NETWORK_REQUESTS.md"),
    }


def build_mirror(yc: Path) -> dict:
    """The August 2023 mirror snapshot behind the sample receipts. No independent timestamp covers it."""
    prov = json.loads((yc / MIRROR).read_text())
    receipts = json.loads((yc / "designation_receipts.json").read_text())
    return {
        "list_snapshot": receipts["list_snapshot"], "rulebook_version": receipts["rulebook_version"],
        "decision_moment": prov["decision_moment"].replace("+00:00", "Z"), "list_entries": prov["list_entries"],
        "sdn_mirror_commit": prov["sdn_mirror_commit"], "anchored_independently": False,
        "source": ref(yc, "designation_receipts.json"), "provenance": ref(yc, MIRROR),
    }


def build_archive(yc: Path, network: Path) -> dict:
    """Everything the List archive view shows."""
    return {
        "schema": 1, "live_proof": build_live_summary(yc), "postings": build_postings(yc), "snapshot": build_snapshot(yc),
        "fetches": build_fetches(yc), "seals": build_seals(network), "mirror": build_mirror(yc),
    }


def build_proof_gap(yc: Path) -> dict:
    """Rows of the proof-gap table exactly as REPORT.md prints them, plus the counts behind each row."""
    text = (yc / PROOF_GAP / "REPORT.md").read_text()
    report = json.loads((yc / PROOF_GAP / "report.json").read_text())
    rows = []
    for line in text.splitlines():
        m = STREAM_ROW.match(line)
        if not m:
            continue
        stream, subset = m["stream"].strip(), m["subset"].strip()
        key = "after_2023_12_09" if subset.startswith("after") else "all"
        counts = report["streams"][stream][key]
        rows.append({
            "stream": stream, "subset": subset, "n": int(m["n"]), "designations": int(m["designations"]),
            "A": m["a"].strip(), "B": m["b"].strip(), "C": m["c"].strip(), "gap": m["gap"].strip(), "M": m["m"].strip(), "counts": counts["counts"],
        })
    if len(rows) != 6:
        raise ValueError(f"expected 6 rows in the proof-gap table, found {len(rows)}")
    return {
        "schema": 1, "rows": rows,
        "definitions": text.splitlines()[2], "adds": next(line for line in text.splitlines() if line.startswith("What a Tollgate receipt adds")),
        "not_checked": next(line for line in text.splitlines() if line.startswith("Not checked")),
        "bootstrap": report["streams"]["USDC (Ethereum)"]["all"]["bootstrap"],
        "source": ref(yc, f"{PROOF_GAP}/REPORT.md"), "source_json": ref(yc, f"{PROOF_GAP}/report.json"), "prereg": report["prereg"],
        "live": build_live_summary(yc),
    }


def main() -> int:
    """Writes both files and logs what was read."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yc", type=Path, default=DEFAULT_YC)
    parser.add_argument("--network", type=Path, default=DEFAULT_NETWORK)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    yc, network = args.yc.expanduser(), args.network.expanduser()
    for name, data in (("archive.json", build_archive(yc, network)), ("proofgap.json", build_proof_gap(yc))):
        path = args.out / name
        path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        log.info("wrote %s (%d bytes)", path, path.stat().st_size)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    raise SystemExit(main())
