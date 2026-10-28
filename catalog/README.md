# Compact public catalog metadata

`index.tsv` contains Project Gutenberg **catalog metadata only**, not ebook text. It is generated from the official machine-readable CSV, filtered to records whose `Type` is `Text`. The first line is JSON metadata; subsequent lines contain `id`, `title`, `author` and comma-separated `languages`, separated by tabs. Titles and authors are limited to 300 and 180 UTF-16 units respectively; embedded tabs, line breaks and repeated whitespace are normalized.

Current snapshot: **2026-10-25**. It contains **78,423** text records and is **7,941,383 bytes**. The input CSV contains 79,674 records and is 21,271,171 bytes.

| Artifact | SHA-256 |
| --- | --- |
| Official CSV content | `3cece81ad3a9261f1b2fbfd2db1e1819cf0c4d3bcffc02ef74ccb8865b46895c` |
| Official mirror gzip distribution | `ebf4f6e54a34dddbcd26ca8a5ef593c9cf3e0ab8b331628ea7a49170a196a07e` |
| Generated `index.tsv` | `d69fe950c5d4fab2cc769337e5061cdc1ec22a4b6576e03a8c5e8dc804caaeac` |

Source: [official CSV](https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv), distributed compressed by the [officially listed Project Gutenberg mirror](https://gutenberg.pglaf.org/cache/epub/feeds/pg_catalog.csv.gz). This snapshot was obtained in validated HTTP range parts with consistent total length and ETag, then checked by gzip CRC and complete-file hashes. Its distribution's `Last-Modified` was `Sun, 25 Oct 2026 21:41:56 GMT`.

Project Gutenberg explicitly provides [machine-readable metadata](https://www.gutenberg.org/ebooks/offline_catalogs.html) for applications and grants catalog data to the public domain in its [robot access policy](https://www.gutenberg.org/policy/robot_access.html). Keep this attribution and the original metadata provenance when redistributing derivatives. [Official mirror list](https://www.gutenberg.org/MIRRORS.ALL).

The CSV does not establish a particular ebook's download formats or its rights status. Those fields are intentionally absent. Before importing a selected work, the server must verify the selected edition's machine-readable RDF metadata and permitted UTF-8 text format. This title/author catalog cannot guarantee a Chinese translation, a particular print edition, or that every listed work is available for import.

## Manual update

Download the official CSV or its gzip distribution to a local file using the published machine-readable endpoint. Verify the complete download; when using gzip, successful decompression must validate its CRC. Record the source snapshot date and hashes. Do not substitute a partial response or scrape human-facing search pages.

From the repository root, run:

```sh
node tools/build-catalog-index.mjs /local/path/pg_catalog.csv --snapshot YYYY-MM-DD
```

The optional `--source` accepts the official CSV URL or `https://gutenberg.pglaf.org/cache/epub/feeds/pg_catalog.csv` for the listed mirror. The generator performs no network request and writes only `catalog/index.tsv`; it rejects invalid CSV, duplicate IDs, invalid languages and output larger than 16 MiB. Update this README's snapshot, sizes and hashes with the new output, run local tests, then follow the repository's review and release rules. Normal builds never download a fresh catalog and no recurring synchronization service is installed.
