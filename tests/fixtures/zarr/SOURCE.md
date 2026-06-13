# OME-Zarr streaming test fixtures

## `idr0062A-6001240-L0-c0z0.blosc`

One raw Zarr v2 chunk taken verbatim from a public OME-NGFF 0.4 dataset, used as a
hermetic golden for VoxelLab's dependency-free Blosc/LZ4/shuffle chunk decoder.

- Source: IDR `idr0062A`, image `6001240.zarr`, multiscale level `0`, chunk `0/0/0/0`
  (axes C,Z,Y,X = 0,0,full,full).
- URL: `https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0062A/6001240.zarr/0/0/0/0/0`
- Array metadata: `dtype=<u2` (uint16 LE), `shape=[2,236,275,271]`, `chunks=[1,1,275,271]`,
  `order=C`, `dimension_separator="/"`, `compressor={id:blosc, cname:lz4, shuffle:1, clevel:5}`.
- License: IDR idr0062 is CC-BY 4.0 (Bleckmann et al.). Attribution retained here; the
  bytes are an unmodified single chunk used only as a decoder test vector.

## `idr0062A-6001240-L0-c0z0.golden.json`

The decoded ground truth for the chunk above, produced by the authoritative
`numcodecs.Blosc().decode()` reference implementation (not by VoxelLab). The
dependency-free decoder under test must reproduce these bytes exactly.

- `nbytes` 149050 = 275 × 271 × 2
- `count` 74525 uint16 values, `min` 6, `max` 132, `mean` 10.4884, `sum` 781649
- `first8` [8, 9, 8, 10, 8, 11, 9, 9]
- `sha256_decoded` a8fb94310fcc714593f1851257a9b5a993513cf8e1c0117de0fdb3c9e6b2efa9
