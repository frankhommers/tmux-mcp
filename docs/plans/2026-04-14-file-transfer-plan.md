# File Transfer Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `file-upload` and `file-download` MCP tools to tmux-mcp for transferring files to/from tmux panes via gzip+base64 encoding.

**Architecture:** Files are compressed with Node's built-in `zlib`, base64-encoded, and sent as a single shell command via the existing `runBlocking()` infrastructure. This reuses the marker-based completion tracking already in place. Both directions (upload/download) are supported.

**Tech Stack:** Node.js `zlib` and `fs/promises` (built-ins), existing `tmux.ts` `runBlocking()`.

---

### Task 1: Add file transfer functions to tmux.ts

**Files:**
- Modify: `src/tmux.ts` (add at end of file, before any closing code)

**Step 1: Add imports**

Add `zlib` and `fs/promises` imports at the top of `src/tmux.ts` (after line 3):

```typescript
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
```

**Step 2: Add the MAX_PAYLOAD constant and helper**

Add after the existing constants section:

```typescript
/**
 * Maximum base64 payload size in characters.
 * Conservative limit for tmux send-keys (~128KB).
 */
const MAX_BASE64_PAYLOAD = 131072;
```

**Step 3: Add `uploadFile()` function**

```typescript
export interface FileUploadOptions {
  paneId: string;
  destinationPath: string;
  sourcePath?: string;
  content?: string;
  permissions?: string;
  suppressHistory?: boolean;
}

export interface FileTransferResult {
  status: 'completed' | 'error';
  message: string;
  bytesTransferred: number;
}

export async function uploadFile(opts: FileUploadOptions): Promise<FileTransferResult> {
  if (!opts.sourcePath && opts.content === undefined) {
    throw new Error('Either sourcePath or content must be provided');
  }
  if (opts.sourcePath && opts.content !== undefined) {
    throw new Error('Provide either sourcePath or content, not both');
  }

  // Read content
  let rawBuffer: Buffer;
  if (opts.sourcePath) {
    rawBuffer = await readFile(opts.sourcePath);
  } else {
    rawBuffer = Buffer.from(opts.content!, 'utf-8');
  }

  const originalSize = rawBuffer.length;

  // Compress with max level
  const compressed = gzipSync(rawBuffer, { level: 9 });

  // Base64 encode
  const base64 = compressed.toString('base64');

  if (base64.length > MAX_BASE64_PAYLOAD) {
    const maxApprox = Math.round(MAX_BASE64_PAYLOAD * 0.75 / 1024);
    throw new Error(
      `File too large: compressed payload is ${base64.length} chars ` +
      `(limit: ${MAX_BASE64_PAYLOAD}). Original size: ${originalSize} bytes. ` +
      `Use scp/rsync for files larger than ~${maxApprox}KB compressed.`
    );
  }

  // Build the shell command
  const destSQ = shellSingleQuote(opts.destinationPath);
  let cmd = `echo '${base64}' | base64 -d | gzip -d > ${destSQ}`;
  if (opts.permissions) {
    cmd += ` && chmod ${opts.permissions} ${destSQ}`;
  }

  const result = await runBlocking(opts.paneId, cmd, {
    timeoutSeconds: 30,
    suppressHistory: opts.suppressHistory,
  });

  if (result.status === 'completed') {
    return {
      status: 'completed',
      message: `Successfully uploaded ${originalSize} bytes to ${opts.destinationPath}`,
      bytesTransferred: originalSize,
    };
  }

  return {
    status: 'error',
    message: `Upload failed (exit ${result.exitCode}): ${result.output}`,
    bytesTransferred: 0,
  };
}
```

**Step 4: Add `downloadFile()` function**

```typescript
export interface FileDownloadOptions {
  paneId: string;
  sourcePath: string;
  destinationPath?: string;
  suppressHistory?: boolean;
}

export interface FileDownloadResult {
  status: 'completed' | 'error';
  message: string;
  content?: string;
  bytesTransferred: number;
}

export async function downloadFile(opts: FileDownloadOptions): Promise<FileDownloadResult> {
  const srcSQ = shellSingleQuote(opts.sourcePath);
  const cmd = `gzip -c ${srcSQ} | base64`;

  const result = await runBlocking(opts.paneId, cmd, {
    timeoutSeconds: 30,
    suppressHistory: opts.suppressHistory,
  });

  if (result.status !== 'completed' || result.exitCode !== 0) {
    return {
      status: 'error',
      message: `Download failed (exit ${result.exitCode}): ${result.output}`,
      bytesTransferred: 0,
    };
  }

  // Extract the base64 output (trim whitespace/newlines)
  const base64 = result.output.trim().replace(/\s+/g, '');

  if (base64.length > MAX_BASE64_PAYLOAD) {
    return {
      status: 'error',
      message: `Remote file too large: compressed payload is ${base64.length} chars (limit: ${MAX_BASE64_PAYLOAD}). Use scp/rsync instead.`,
      bytesTransferred: 0,
    };
  }

  // Decode
  const compressed = Buffer.from(base64, 'base64');
  const rawBuffer = gunzipSync(compressed);
  const bytesTransferred = rawBuffer.length;

  if (opts.destinationPath) {
    await writeFile(opts.destinationPath, rawBuffer);
    return {
      status: 'completed',
      message: `Successfully downloaded ${bytesTransferred} bytes to ${opts.destinationPath}`,
      bytesTransferred,
    };
  }

  // Return content as text
  return {
    status: 'completed',
    message: `Successfully downloaded ${bytesTransferred} bytes`,
    content: rawBuffer.toString('utf-8'),
    bytesTransferred,
  };
}
```

**Step 5: Build and verify no compile errors**

Run: `npm run build`
Expected: Clean compilation

**Step 6: Commit**

```bash
git add src/tmux.ts
git commit -m "feat: add uploadFile and downloadFile functions to tmux library"
```

---

### Task 2: Register file-upload MCP tool in index.ts

**Files:**
- Modify: `src/index.ts` (add tool registration before the `disableToolsByScope` function around line 963)

**Step 1: Add the `file-upload` tool registration**

Add before the `disableToolsByScope` function:

```typescript
// File upload - Host/inline -> Pane
server.tool(
  "file-upload",
  "Upload a file or inline content to a tmux pane. The content is gzip-compressed and base64-encoded on the host, sent as a single shell command, and decoded in the pane. Works over SSH/docker/any remote shell. Max ~128KB compressed payload (text files up to ~500KB thanks to gzip compression). Use scp/rsync for larger files.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    destinationPath: z.string().describe("Path where the file will be written in the pane"),
    sourcePath: z.string().optional().describe("Local file path on the MCP host. Either sourcePath or content must be provided."),
    content: z.string().optional().describe("Inline text content to upload. Either sourcePath or content must be provided."),
    permissions: z.string().optional().describe("chmod permissions to set, e.g. '755' for executable scripts"),
    suppressHistory: z.boolean().optional().describe("Prepend space to avoid shell history"),
  },
  async (args) => {
    try {
      if (isExcludedPane(args.paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${args.paneId} is the agent's own pane and is excluded.` }], isError: true };
      }
      await assertInScope(args.paneId, 'pane');
      const result = await tmux.uploadFile({
        paneId: args.paneId,
        destinationPath: args.destinationPath,
        sourcePath: args.sourcePath,
        content: args.content,
        permissions: args.permissions,
        suppressHistory: args.suppressHistory,
      });
      const status = result.status === 'completed' ? 'completed' : 'error';
      return {
        content: [{ type: "text", text: `Status: ${status}\n${result.message}\nBytes transferred: ${result.bytesTransferred}` }],
        isError: result.status === 'error',
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error uploading file: ${error}` }], isError: true };
    }
  }
);
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: register file-upload MCP tool"
```

---

### Task 3: Register file-download MCP tool in index.ts

**Files:**
- Modify: `src/index.ts` (add after the file-upload tool)

**Step 1: Add the `file-download` tool registration**

```typescript
// File download - Pane -> Host
server.tool(
  "file-download",
  "Download a file from a tmux pane to the local host or return its content. The file is gzip-compressed and base64-encoded in the pane, captured via command output, and decoded on the host. Works over SSH/docker/any remote shell. If destinationPath is omitted, the file content is returned as text. Max ~128KB compressed payload.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    sourcePath: z.string().describe("Path of the file in the pane"),
    destinationPath: z.string().optional().describe("Local path to write the file to. If omitted, content is returned as text."),
    suppressHistory: z.boolean().optional().describe("Prepend space to avoid shell history"),
  },
  async (args) => {
    try {
      if (isExcludedPane(args.paneId)) {
        return { content: [{ type: "text", text: `Access denied: pane ${args.paneId} is the agent's own pane and is excluded.` }], isError: true };
      }
      await assertInScope(args.paneId, 'pane');
      const result = await tmux.downloadFile({
        paneId: args.paneId,
        sourcePath: args.sourcePath,
        destinationPath: args.destinationPath,
        suppressHistory: args.suppressHistory,
      });
      if (result.status === 'error') {
        return { content: [{ type: "text", text: `Status: error\n${result.message}` }], isError: true };
      }
      let text = `Status: completed\n${result.message}\nBytes transferred: ${result.bytesTransferred}`;
      if (result.content !== undefined) {
        text += `\n\n--- Content ---\n${result.content}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error downloading file: ${error}` }], isError: true };
    }
  }
);
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: register file-download MCP tool"
```

---

### Task 4: Manual integration test

**Step 1: Build the project**

Run: `npm run build`

**Step 2: Test file-upload with inline content**

Use the MCP tool `file-upload` with:
- `paneId`: a test pane
- `destinationPath`: `/tmp/test-upload.txt`
- `content`: `"Hello from tmux-mcp file transfer!"`

**Step 3: Verify the uploaded file**

Run in the test pane: `cat /tmp/test-upload.txt`
Expected: `Hello from tmux-mcp file transfer!`

**Step 4: Test file-download**

Use the MCP tool `file-download` with:
- `paneId`: the test pane
- `sourcePath`: `/tmp/test-upload.txt`

Expected: content returned as text matching what was uploaded.

**Step 5: Test file-upload with sourcePath**

Create a local test file, upload it, verify in pane.

**Step 6: Test file-download to local file**

Download from pane to a local path, verify content matches.

**Step 7: Test with permissions**

Upload a script with `permissions: "755"`, verify with `ls -la`.

**Step 8: Commit any fixes if needed**

---

### Task 5: Final commit and push

**Step 1: Ensure all changes are committed**

Run: `git status`

**Step 2: Push to fork**

```bash
git push fork main
```
