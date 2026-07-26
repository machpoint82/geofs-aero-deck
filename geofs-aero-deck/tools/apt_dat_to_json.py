#!/usr/bin/env python3
"""
apt_dat_to_json.py

Converts an X-Plane Scenery Gateway apt.dat file into a structured JSON
airport diagram file for the GeoFS Live Charts addon.

Usage:
    python apt_dat_to_json.py KJFK.dat KJFK.json

Extracts:
    - airport header / metadata
    - runways (100)
    - helipads (102)
    - pavement polygons: taxiways & aprons (110 + 111/112/113/114/115/116)
    - linear features / paint markings (120 + node chain)   [optional layer]
    - airport boundary (130 + node chain)                    [optional layer]
    - gates / ramp starts (1300 + 1301)
    - freestanding taxiway signs (20)
    - COM frequencies (1050-1056)

Deliberately ignored (not needed for a visual ground diagram):
    - AI taxi route network (1200/1201/1202/1204/1206)
    - ground truck parking/destinations (1400/1401)
    - runway-use / wind flow rules (1000-1004, 1100/1101, 1110)
    - lighting objects (18, 21), windsocks (19) -- can be added later
"""

import json
import sys
from dataclasses import dataclass, field, asdict


# Row codes that represent a "node" inside a pavement/linear-feature/boundary chain.
# 111/112 = mid-chain node (112 = has a bezier control point)
# 113/114 = node that CLOSES the ring (loops back to the first point)
# 115/116 = node that ENDS an open chain (does not close)
NODE_PLAIN = {111, 113, 115}
NODE_BEZIER = {112, 114, 116}
NODE_CLOSE = {113, 114}
NODE_END = {115, 116}
NODE_ALL = NODE_PLAIN | NODE_BEZIER


def parse_node_line(parts):
    """Return (lat, lon, is_bezier, ctrl_lat, ctrl_lon) for a 111-116 row."""
    code = int(parts[0])
    lat = float(parts[1])
    lon = float(parts[2])
    if code in NODE_BEZIER:
        ctrl_lat = float(parts[3])
        ctrl_lon = float(parts[4])
        return lat, lon, True, ctrl_lat, ctrl_lon
    return lat, lon, False, None, None


def parse_chain(lines, start_idx):
    """
    Parse a run of 111-116 node rows starting at start_idx.
    Returns (points, closed, next_idx) where points is a list of
    {"lat":..,"lon":..} and optionally "ctrl" for bezier points.
    """
    points = []
    closed = False
    i = start_idx
    while i < len(lines):
        parts = lines[i]
        code = int(parts[0])
        if code not in NODE_ALL:
            break
        lat, lon, is_bezier, clat, clon = parse_node_line(parts)
        pt = {"lat": round(lat, 8), "lon": round(lon, 8)}
        if is_bezier:
            pt["ctrl"] = {"lat": round(clat, 8), "lon": round(clon, 8)}
        points.append(pt)
        i += 1
        if code in NODE_CLOSE:
            closed = True
            break
        if code in NODE_END:
            closed = False
            break
    return points, closed, i


def convert(dat_path):
    with open(dat_path, "r", encoding="utf-8", errors="replace") as f:
        raw_text = f.read()
    return convert_from_text(raw_text)


def convert_from_text(raw_text):
    raw_lines = raw_text.splitlines()

    # tokenize, skip blank lines
    lines = []
    for ln in raw_lines:
        ln = ln.strip()
        if not ln:
            continue
        lines.append(ln.split())

    airport = {"icao": None, "name": None, "elevation_ft": None,
               "lat": None, "lon": None}
    metadata = {}
    runways = []
    helipads = []
    pavements = []       # taxiways + aprons (110 records)
    linear_features = []  # 120 records (paint lines) - optional layer
    boundary = None      # 130 record - optional layer
    gates = []
    signs = []
    frequencies = []
    taxi_nodes = {}      # id -> (lat, lon)     from 1201
    taxi_edges = []       # (lat1,lon1,lat2,lon2,name)  from 1202

    i = 0
    n = len(lines)
    while i < n:
        parts = lines[i]
        code = parts[0]

        # --- Airport header ---
        if code == "1":
            airport["elevation_ft"] = float(parts[1])
            airport["name"] = " ".join(parts[5:])
            i += 1
            continue

        if code == "1302":
            key = parts[1]
            val = " ".join(parts[2:])
            metadata[key] = val
            if key == "icao_code":
                airport["icao"] = val
            if key == "datum_lat":
                airport["lat"] = float(val)
            if key == "datum_lon":
                airport["lon"] = float(val)
            i += 1
            continue

        # --- Runway (land) ---
        if code == "100":
            width_m = float(parts[1])
            surface = parts[2]
            end1 = {
                "id": parts[8],
                "lat": float(parts[9]),
                "lon": float(parts[10]),
            }
            end2 = {
                "id": parts[17],
                "lat": float(parts[18]),
                "lon": float(parts[19]),
            }
            runways.append({
                "width_m": width_m,
                "surface": surface,
                "ends": [end1, end2],
            })
            i += 1
            continue

        # --- Helipad ---
        if code == "102":
            helipads.append({
                "id": parts[1],
                "lat": float(parts[2]),
                "lon": float(parts[3]),
                "heading": float(parts[4]),
                "length_m": float(parts[5]),
                "width_m": float(parts[6]),
            })
            i += 1
            continue

        # --- Pavement (taxiway / apron) polygon ---
        if code == "110":
            name = " ".join(parts[4:]) if len(parts) > 4 else ""
            points, closed, next_i = parse_chain(lines, i + 1)
            # crude heuristic: gateway contributors usually name aprons
            # "Apron"/"Ramp"/cargo/gate-area names; everything else is a taxiway.
            lname = name.lower()
            kind = "apron" if any(k in lname for k in
                                   ("apron", "ramp", "cargo", "gate", "stand", "parking")) else "taxiway"
            pavements.append({
                "name": name,
                "kind": kind,
                "closed": closed,
                "points": points,
            })
            i = next_i
            continue

        # --- Linear feature (paint markings) ---
        if code == "120":
            name = " ".join(parts[1:]) if len(parts) > 1 else ""
            points, closed, next_i = parse_chain(lines, i + 1)
            linear_features.append({"name": name, "closed": closed, "points": points})
            i = next_i
            continue

        # --- Airport boundary ---
        if code == "130":
            points, closed, next_i = parse_chain(lines, i + 1)
            boundary = {"closed": closed, "points": points}
            i = next_i
            continue

        # --- Gate / ramp start (+ optional 1301 extension) ---
        if code == "1300":
            gate = {
                "lat": float(parts[1]),
                "lon": float(parts[2]),
                "heading": float(parts[3]),
                "type": parts[4],                 # gate / hangar / tie-down / misc
                "aircraft_categories": parts[5] if len(parts) > 5 else "",
                "name": " ".join(parts[6:]) if len(parts) > 6 else "",
            }
            # look ahead for a 1301 extension line (airline/operation type)
            if i + 1 < n and lines[i + 1][0] == "1301":
                ext = lines[i + 1]
                gate["operation_type"] = ext[1] if len(ext) > 1 else None
                gate["airline_category"] = ext[2] if len(ext) > 2 else None
                gate["airline_code"] = ext[3] if len(ext) > 3 else None
                i += 1
            gates.append(gate)
            i += 1
            continue

        # --- Taxi route network node (carries a real node id, unlike the
        #     pavement polygons above) ---
        if code == "1201":
            node_id = parts[4]
            taxi_nodes[node_id] = (float(parts[1]), float(parts[2]))
            i += 1
            continue

        # --- Taxi route network edge: last token is the REAL taxiway
        #     letter/number, e.g. "1202 29 395 twoway taxiway_F H" -> "H" ---
        if code == "1202":
            n1, n2 = parts[1], parts[2]
            # fields: 1202 <n1> <n2> <oneway|twoway> <taxiway_X|runway> [name]
            # some edges (usually inside a single apron/ramp) have no name at all
            name = parts[5] if len(parts) >= 6 else None
            if name:
                taxi_edges.append({"n1": n1, "n2": n2, "name": name})
            i += 1
            continue

        # --- Freestanding taxiway sign ---
        if code == "20":
            signs.append({
                "lat": float(parts[1]),
                "lon": float(parts[2]),
                "heading": float(parts[3]),
                "text": " ".join(parts[5:]),
            })
            i += 1
            continue

        # --- COM frequencies ---
        if code in {"1050", "1051", "1052", "1053", "1054", "1055", "1056"}:
            freq_khz = int(parts[1])
            label = " ".join(parts[2:])
            kind = {
                "1050": "ATIS", "1051": "UNICOM", "1052": "CLD",
                "1053": "GND", "1054": "TWR", "1055": "APP", "1056": "DEP",
            }[code]
            frequencies.append({"type": kind, "freq_mhz": freq_khz / 100.0, "label": label})
            i += 1
            continue

        i += 1

    _label_pavements_with_taxi_network(pavements, taxi_nodes, taxi_edges)

    # keep only nodes actually referenced by a named edge, to keep the file lean
    used_ids = set()
    for e in taxi_edges:
        used_ids.add(e["n1"]); used_ids.add(e["n2"])
    taxi_network = {
        "nodes": {nid: {"lat": lat, "lon": lon} for nid, (lat, lon) in taxi_nodes.items() if nid in used_ids},
        "edges": taxi_edges,
    }

    return {
        "airport": airport,
        "metadata": metadata,
        "runways": runways,
        "helipads": helipads,
        "pavements": pavements,
        "linear_features": linear_features,
        "boundary": boundary,
        "gates": gates,
        "signs": signs,
        "frequencies": frequencies,
        "taxi_network": taxi_network,
    }


def _label_pavements_with_taxi_network(pavements, taxi_nodes, taxi_edges, max_dist_m=45.0):
    """
    The 110 pavement polygons have useless auto-generated names ("New Taxiway 142").
    The 1201/1202 taxi-route network carries the REAL taxiway letters (e.g. "GG",
    "KF", "Q4") on edges that run down the middle of each taxiway.

    For every edge, find the nearest pavement polygon (by min distance from the
    edge midpoint to any boundary point, in metres) and cast a vote for that
    polygon's name. Each polygon's final `taxiway_id` is its majority-vote name,
    if a vote landed within max_dist_m; otherwise it's left unlabeled (which
    usually means it's an apron/ramp area, not a through-taxiway).
    """
    if not taxi_edges or not pavements:
        return

    import math

    def project(lat, lon, ref_lat, ref_lon):
        R = 6371000.0
        dlat = math.radians(lat - ref_lat)
        dlon = math.radians(lon - ref_lon)
        x = dlon * math.cos(math.radians(ref_lat)) * R
        y = dlat * R
        return x, y

    ref_lat = sum(lat for lat, lon in taxi_nodes.values()) / len(taxi_nodes)
    ref_lon = sum(lon for lat, lon in taxi_nodes.values()) / len(taxi_nodes)

    pave_xy = []
    for p in pavements:
        pts = [project(pt["lat"], pt["lon"], ref_lat, ref_lon) for pt in p["points"]]
        pave_xy.append(pts)

    votes = [dict() for _ in pavements]

    for e in taxi_edges:
        if e["n1"] not in taxi_nodes or e["n2"] not in taxi_nodes:
            continue
        lat1, lon1 = taxi_nodes[e["n1"]]
        lat2, lon2 = taxi_nodes[e["n2"]]
        mx, my = project((lat1 + lat2) / 2, (lon1 + lon2) / 2, ref_lat, ref_lon)

        best_idx, best_dist = None, float("inf")
        for idx, pts in enumerate(pave_xy):
            for (px_, py_) in pts:
                d = (px_ - mx) ** 2 + (py_ - my) ** 2
                if d < best_dist:
                    best_dist = d
                    best_idx = idx
        if best_idx is not None and best_dist ** 0.5 <= max_dist_m:
            votes[best_idx][e["name"]] = votes[best_idx].get(e["name"], 0) + 1

    for p, v in zip(pavements, votes):
        if v:
            winner = max(v.items(), key=lambda kv: kv[1])[0]
            p["taxiway_id"] = winner
            p["kind"] = "taxiway"
        else:
            p["kind"] = "apron"


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python apt_dat_to_json.py <input.dat> <output.json>")
        sys.exit(1)
    data = convert(sys.argv[1])
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"OK: {sys.argv[2]}")
    print(f"  runways={len(data['runways'])} pavements={len(data['pavements'])} "
          f"gates={len(data['gates'])} linear_features={len(data['linear_features'])}")
