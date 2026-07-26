# geofs-aero-deck

GeoFS Live Charts — airport ground diagrams (runways, taxiways, aprons,
gates) generated from the X-Plane Scenery Gateway, for use in the aerodeck
tablet addon.

## Layout

```
geofs-aero-deck/
├── charts/          # generated <ICAO>.json chart files land here
├── tools/
│   ├── apt_dat_to_json.py           # converts one apt.dat -> one chart JSON
│   └── geofs_charts_bulk_fetch.py   # bulk-converts a list of ICAOs
└── airports.txt     # one ICAO per line, input for the bulk fetch
```

## Usage

Convert a single airport (if you already have a `.dat` file on disk):
```
python tools/apt_dat_to_json.py KJFK.dat charts/KJFK.json
```

Bulk-convert a list of airports straight from the Gateway:
```
python tools/geofs_charts_bulk_fetch.py --file airports.txt --out charts/
```

No external dependencies — both scripts are pure standard library (no
`pip install` needed).

## Chart JSON schema (per airport)

- `airport` — icao, name, elevation, lat/lon (projection origin)
- `runways[]` — width, surface, both ends (id, lat, lon)
- `pavements[]` — taxiway/apron polygons; `kind`: "taxiway" | "apron",
  `taxiway_id` (real letter, when matched)
- `taxi_network` — real taxi-route nodes/edges (used to draw + label
  taxiway centerlines)
- `gates[]` — lat, lon, heading, type, name, airline info
- `linear_features[]`, `signs[]`, `frequencies[]` — secondary/optional layers

## Status

- Converter validated against KJFK (real data, all layers checked).
- Bulk fetcher's Gateway-API calls are **untested** against the live API
  (no network access in the environment that wrote it) — test on 2-3
  ICAOs before trusting it for a full batch.
- Renderer (the Navigraph-style HTML/SVG diagram) isn't in this repo yet —
  add it once you've settled where it should live (its own folder here,
  or inside the aerodeck tablet addon repo directly).
