# File Transfer MCP Tools Design

**Date:** 2026-04-14
**Status:** Approved

## Problem

AI agents and users need to transfer files to/from tmux panes that may be running SSH sessions, docker exec, or other remote shells where direct filesystem access is unavailable. The existing tmux-mcp toolset has no file transfer capability.

## Approach

Use the existing `runBlocking()` infrastructure to send/receive files as gzip-compressed, base64-encoded payloads via single shell commands. No chunked `send-keys` — one command per transfer.

## Tools

### `file-upload` — Host/inline content -> Pane

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `paneId` | string | yes | Target pane |
| `destinationPath` | string | yes | Path where file is written in the pane |
| `sourcePath` | string | no* | Local file on MCP host |
| `content` | string | no* | Inline text content |
| `permissions` | string | no | chmod value, e.g. `"755"` |

*One of `sourcePath` or `content` is required.

**Flow:**

1. Read content from disk (`sourcePath`) or use inline `content`
2. Compress with `zlib.gzipSync()` (Node built-in, max compression level 9)
3. Base64-encode the compressed result
4. Reject if base64 payload > 131072 chars (~128KB)
5. Build command: `echo '<base64>' | base64 -d | gzip -d > /dest/path`
6. Optionally append `&& chmod <permissions> /dest/path`
7. Execute via `runBlocking()` with 30s timeout
8. Return success/failure based on exit code

### `file-download` — Pane -> Host

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `paneId` | string | yes | Source pane |
| `sourcePath` | string | yes | Path of file in the pane |
| `destinationPath` | string | no | Local path to write to |

If `destinationPath` is omitted, return content as text in the MCP response.

**Flow:**

1. Execute via `runBlocking()`: `gzip -c /source/path | base64`
2. Parse base64 output from between command markers
3. Base64-decode, then `zlib.gunzipSync()` to decompress
4. If `destinationPath`: write to local disk. Otherwise: return as text content
5. Apply same payload size limit check on the compressed output

## Size Limits

- **Max base64 payload:** 131072 chars (~128KB) — conservative limit for tmux send-keys
- **Effective max uncompressed:**
  - Text files (configs, source): ~400-500KB+ (70-90% compression)
  - Binaries: ~100-150KB (minimal compression)
- **Error message when too large:** clear advice to use `scp`/`rsync` instead

## Compression Strategy

- Compression: `zlib.gzipSync()` on the MCP host (Node built-in, no dependency)
- Decompression in pane: `gzip -d` (available on virtually all POSIX systems)
- Compression on pane (download): `gzip -c` 
- Decompression on host: `zlib.gunzipSync()`

## Error Handling

- File not found (local on upload, remote on download)
- Destination path not writable
- File too large after compression
- `gzip` / `base64` not available in the pane shell
- Timeout during `runBlocking()`
- Both `sourcePath` and `content` provided (or neither)

## Why Not Chunked send-keys

The original approach (send base64 line-by-line via heredoc) has issues:
- Fragile: timing-dependent, shell state matters
- Slow: `sleep 0.02` per line
- No completion tracking (no markers per chunk)
- Complex error handling for partial failures

Single-command approach via `runBlocking()` is reliable, tracked, and fast.

## Dependencies

- `zlib` — Node built-in, no new npm dependencies needed
- `fs/promises` — Node built-in, already available
