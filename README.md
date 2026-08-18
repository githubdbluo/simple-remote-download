# Simple Remote Download

VS Code extension that browses the remote filesystem and downloads any file or directory to a local path — no workspace mount, drag-and-drop, or `scp` round-trip required.

Runs as a **UI extension** (`"extensionKind": ["ui"]`), so it works in any remote window: SSH, Dev Containers, WSL, tunnels.

## Usage

1. Open any remote window (or just a remote file/tab — the extension borrows the remote authority from whatever the window holds).
2. Run **Remote: Download Remote File by Path...** from the Command Palette.
3. Browse in the QuickPick:
   - **Enter** on a folder descends into it.
   - **Enter** on a file downloads it.
   - **Enter** on the `.` row, or the cloud-download button on a folder, downloads that directory.
4. For directories, choose a format, then pick a local destination in the native save dialog (defaults to `~/Downloads`).

## Directory formats

| Format | How it's produced |
|---|---|
| None | `workspace.fs.copy` of the directory tree as-is |
| `.zip` | files streamed over `workspace.fs`, zipped locally with [fflate](https://github.com/101arrowz/fflate) |
| `.tar` | `tar` run on the remote, archive pulled down |
| `.tar.gz` / `.tar.xz` / `.tar.zst` | remote `tar` + `gzip` / `xz` / `zstd` |

The tar options only appear when the corresponding binaries exist on the remote. Detection runs a silent shell task once per remote authority and caches the result for the session. Windows remotes (and remotes where tasks are unavailable) fall back to zip and plain copy, which use only `workspace.fs` and work on any OS.

## How it works

- **Remote root**: the remote authority isn't exposed to UI extensions directly, so it's taken from any `vscode-remote:` URI in the window — workspace folders, the workspace file, or open tabs.
- **Remote OS**: also not exposed, so it's inferred from filesystem shape (drive-letter paths or a readable `/C:/` → Windows; `/etc` or `/bin` → POSIX).
- **Remote shell**: tar commands run through a hidden VS Code task; temp files under `/tmp/srd-*` are cleaned up afterwards.
- **Transfer**: all file movement goes through `workspace.fs`, which VS Code proxies over the remote connection.

## Requirements

- VS Code ≥ 1.75.
- A remote connection of some kind; the command errors out in a purely local window.
- For tar formats: `tar` (plus `gzip`/`xz`/`zstd` for compressed variants) on a POSIX remote.

## Install

From a `.vsix`:

```sh
code --install-extension simple-remote-download-<version>.vsix
```

Or package from source with [`vsce`](https://github.com/microsoft/vscode-vsce):

```sh
npx @vscode/vsce package
```

## License

MIT
