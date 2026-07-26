#!/usr/bin/env python3
"""
geofs_charts_bulk_fetch.py

Bulk-converts a list of ICAOs into GeoFS Live Charts JSON files, using
X-Plane's own official `xplane_airports` library to pull data from the
Scenery Gateway (pip install xplane_airports) instead of hand-rolled
HTTP calls.

Usage:
    pip install xplane_airports
    python tools/geofs_charts_bulk_fetch.py --file airports.txt --out charts/
"""

import argparse
import json
import os

from xplane_airports.gateway import recommended_scenery_packs
from apt_dat_to_json import convert_from_text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="text file, one ICAO per line")
    ap.add_argument("--out", required=True, help="output directory for <ICAO>.json files")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    with open(args.file, "r", encoding="utf-8") as f:
        icaos = [line.strip().upper() for line in f if line.strip()]

    ok, failed = [], []
    total = len(icaos)

    for i, pack in enumerate(recommended_scenery_packs(icaos), 1):
        icao = pack.apt.id
        print(f"[{i}/{total}] {icao} ... ", end="", flush=True)
        try:
            raw_text = "\n".join(pack.apt.raw_lines)
            data = convert_from_text(raw_text)
            out_path = os.path.join(args.out, f"{icao}.json")
            with open(out_path, "w", encoding="utf-8") as out_f:
                json.dump(data, out_f)
            print(f"OK ({len(data['runways'])} rwy, {len(data['pavements'])} pave, "
                  f"{len(data['gates'])} gates)")
            ok.append(icao)
        except Exception as e:
            print(f"FAILED: {e}")
            failed.append((icao, str(e)))

    print(f"\nDone. {len(ok)} converted, {len(failed)} failed.")
    if failed:
        print("Failed:", ", ".join(f"{icao} ({err})" for icao, err in failed))


if __name__ == "__main__":
    main()
