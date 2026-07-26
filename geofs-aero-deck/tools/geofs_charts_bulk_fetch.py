#!/usr/bin/env python3
"""
geofs_charts_bulk_fetch.py

Bulk-converts a list of ICAOs into GeoFS Live Charts JSON files, pulling each
airport's data straight from the X-Plane Scenery Gateway API — same idea as
the gate-spawner's geofs_bulk_fetch.py, just producing full chart JSON
(runways/taxiways/aprons/gates) instead of gates-only.

Usage:
    python geofs_charts_bulk_fetch.py --file airports.txt --out charts/

airports.txt: one ICAO per line, same format as the gate-spawner's list.

NOTE: this implements the Gateway API from public documentation/known
endpoints (apiv1/airport/{icao} -> apiv1/scenery/{id} -> masterZipBlob).
If your existing geofs_bulk_fetch.py already does this differently (auth,
a mirror, rate limiting you tuned by trial and error), trust that one over
this — swap the fetch_airport_dat() function below for whatever it does
and keep everything after it (the conversion + saving) as-is.
"""

import argparse
import base64
import io
import json
import sys
import time
import zipfile

import urllib.request
import urllib.error

from apt_dat_to_json import convert_from_text

GATEWAY_API = "https://gateway.x-plane.com/apiv1"


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "geofs-live-charts-bulk/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_airport_dat(icao):
    """
    Returns the raw apt.dat text for an ICAO's recommended Gateway scenery,
    or None if the airport isn't on the Gateway / has no scenery submissions.
    """
    airport_info = fetch_json(f"{GATEWAY_API}/airport/{icao}")
    scenery_list = airport_info.get("scenery", [])
    if not scenery_list:
        return None

    # prefer the recommended submission if the API flags one, else the latest
    recommended_id = airport_info.get("recommendedSceneryId")
    chosen = None
    if recommended_id:
        chosen = next((s for s in scenery_list if s.get("sceneryId") == recommended_id), None)
    if not chosen:
        chosen = sorted(scenery_list, key=lambda s: s.get("sceneryId", 0))[-1]

    scenery = fetch_json(f"{GATEWAY_API}/scenery/{chosen['sceneryId']}")
    blob_b64 = scenery.get("scenery", {}).get("masterZipBlob") or scenery.get("masterZipBlob")
    if not blob_b64:
        return None

    zip_bytes = base64.b64decode(blob_b64)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        apt_dat_name = next((n for n in zf.namelist() if n.endswith("apt.dat")), None)
        if not apt_dat_name:
            return None
        return zf.read(apt_dat_name).decode("utf-8", errors="replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="text file, one ICAO per line")
    ap.add_argument("--out", required=True, help="output directory for <ICAO>.json files")
    ap.add_argument("--delay", type=float, default=1.0,
                     help="seconds to wait between airports (be polite to the Gateway API)")
    args = ap.parse_args()

    import os
    os.makedirs(args.out, exist_ok=True)

    with open(args.file, "r", encoding="utf-8") as f:
        icaos = [line.strip().upper() for line in f if line.strip()]

    ok, failed, skipped = [], [], []

    for i, icao in enumerate(icaos, 1):
        print(f"[{i}/{len(icaos)}] {icao} ... ", end="", flush=True)
        try:
            raw_text = fetch_airport_dat(icao)
            if raw_text is None:
                print("no Gateway data, skipped")
                skipped.append(icao)
                continue

            data = convert_from_text(raw_text)
            out_path = os.path.join(args.out, f"{icao}.json")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(data, f)

            print(f"OK ({len(data['runways'])} rwy, {len(data['pavements'])} pave, "
                  f"{len(data['gates'])} gates)")
            ok.append(icao)

        except urllib.error.HTTPError as e:
            print(f"HTTP error {e.code}, skipped")
            failed.append((icao, str(e)))
        except Exception as e:
            print(f"FAILED: {e}")
            failed.append((icao, str(e)))

        time.sleep(args.delay)

    print(f"\nDone. {len(ok)} converted, {len(skipped)} skipped (no Gateway data), "
          f"{len(failed)} failed.")
    if failed:
        print("Failed:", ", ".join(f"{icao} ({err})" for icao, err in failed))


if __name__ == "__main__":
    main()
