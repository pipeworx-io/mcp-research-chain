# @pipeworx/research-chain

Everything openly available around one academic paper, in a single call: full
text, license, datasets, code, and citations. Given a DOI, PMID, or arXiv id,
`research_chain` walks the join that Crossref, OpenAlex, Unpaywall, DataCite,
Zenodo, Hugging Face Papers, PubMed Central, and Semantic Scholar each expose
piecemeal — so a caller no longer has to know all six/seven tools to answer
"what datasets and code are linked to this paper?" or "find an open copy of
this DOI and its license."

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `research_chain({doi | pmid | arxiv_id, max_datasets?, max_citing?})` —
  returns:
  - `paper` — title, journal, publisher, authors, Crossref's stated license(s)
    (URL + which manuscript version each applies to), OpenAlex concepts and
    citation count.
  - `open_copies[]` — every open-access location Unpaywall knows about, each
    with its OWN `host_type`, `version` (`publishedVersion` |
    `acceptedVersion` | `submittedVersion`), and `license` — **never
    collapsed**. `is_oa: true` only means "a free-to-read copy exists
    somewhere"; it says nothing about reuse rights, which is why `license` is
    `null` (not guessed) whenever Unpaywall doesn't state one. A PubMed
    Central copy (if one exists) is added as its own entry with `license` and
    `version` explicitly `null`, since NCBI's ID Converter confirms the copy
    exists but doesn't state its terms.
  - `pmc_full_text` — `{has_full_text, pmcid, pmid, url}` from NCBI's ID
    Converter.
  - `datasets` — `{total, returned, results[]}` from DataCite's
    `relatedIdentifiers` search (datasets/software that cite the paper's DOI).
    `total` is the real upstream count even when `results` is truncated to
    `max_datasets`.
  - `code` — `{zenodo[], paperswithcode}`. Zenodo is searched by
    `metadata.related_identifiers.identifier`. `paperswithcode` (Hugging Face
    Papers, the de-facto successor) reports `{found: false, results: []}`
    when the upstream search comes back empty — **an empty result is
    `not_found`, never treated as an answer** (a bare `[]` from this upstream
    used to be routed to as if it were a real "no code exists" answer).
  - `citing` — `{count, top[], note}` from Semantic Scholar: `count` is the
    paper's total citation count, `top` is up to `max_citing` citing papers
    sorted by their own citation count. `note` carries an honest partial-
    failure message (e.g. a rate limit) when one of the two Semantic Scholar
    calls failed but the other succeeded — it is never silently dropped.
  - `retraction` — derived from the SAME Crossref record already fetched for
    `paper` (title marker, `update-to` retraction notices, `is-retracted-by`
    relation) — no extra API call. `retracted: false` means "no retraction on
    record", not proof the paper is clean (coverage depends on the
    publisher).
  - `sources_used` / `sources_failed` — every leg fetches independently and
    in parallel; a slow or dead upstream lands in `sources_failed` with a
    reason, and every other leg still returns.
  - `as_of` — ISO timestamp of the call.

## Auth

Keyless. Every upstream here is a public, unauthenticated API. Crossref,
OpenAlex, and the NCBI ID Converter ask only for a polite-pool contact email,
which this pack supplies as its own (`hello@pipeworx.io`) — the same pattern
as the `crossref`, `openalex`, and `unpaywall` packs.

## Data sources

- <https://api.crossref.org/works/{doi}> — title, journal, license, retraction markers.
- <https://api.openalex.org/works/doi:{doi}> — concepts, citation count.
- <https://api.unpaywall.org/v2/{doi}> — open-access locations, each with version + license.
- <https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/> — DOI/PMID ↔ PMCID resolution. **NCBI moved this off `www.ncbi.nlm.nih.gov/pmc/utils/idconv` in 2026 — the old host 301-redirects here; this pack hits the new host directly.**
- <https://api.datacite.org/dois> — datasets/software citing the paper (`relatedIdentifiers.relatedIdentifier` search).
- <https://zenodo.org/api/records> — records related to the paper. **The search field is `metadata.related_identifiers.identifier`, not the bare `related_identifiers.identifier` — the bare field silently matches zero records for every query** (verified live: 0 vs 19 hits for the same DOI).
- <https://huggingface.co/api/papers/search> — code/implementation search (successor to the shut-down Papers with Code API).
- <https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}> and `/citations` — citation count + citing papers. Keyless pool is ~1 req/sec cumulative across BOTH endpoints; this pack sequences them with a ~1.1s stagger inside one leg rather than firing both in the same instant, which 429'd one of them on nearly every call before the fix.

**OSF was scoped as a third code/materials source but dropped**: its public
API has no DOI-filterable field (`/v2/preprints/?filter[doi]=...` returns HTTP
400 "not a filterable field", verified live). Zenodo + Hugging Face Papers
cover the code/materials join for now.

## Identifier resolution

- `doi` — used directly (a `doi.org` URL or `doi:` prefix is stripped).
- `pmid` — resolved to a DOI via NCBI's ID Converter.
- `arxiv_id` — resolved to arXiv's own auto-registered DataCite DOI
  (`10.48550/arXiv.<id>`), which covers essentially every arXiv submission
  since 2022. This is a **construction, not a verified lookup** — a
  pre-2022 arXiv id without a registered DOI will report `not_found` on the
  downstream legs rather than resolving.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "research-chain": {
      "url": "https://gateway.pipeworx.io/research-chain/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/research-chain/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "research-chain": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-research-chain"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-research-chain
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Research Chain data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
