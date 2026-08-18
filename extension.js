const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { zipSync } = require('fflate');

// ---------------------------------------------------------------------------
// Remote browsing
// ---------------------------------------------------------------------------

/**
 * Starting directory for the browser. The remote authority is not exposed by
 * the API directly, so borrow it from any vscode-remote URI the window holds:
 * workspace folders, the workspace file, or any open tab.
 */
function remoteRoot() {
	const folder = vscode.workspace.workspaceFolders?.find(
		f => f.uri.scheme === 'vscode-remote'
	);
	if (folder) {
		return folder.uri;
	}
	const uris = [
		vscode.workspace.workspaceFile,
		...vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.input?.uri)),
	];
	const remote = uris.find(u => u?.scheme === 'vscode-remote');
	if (remote) {
		// Windows remotes surface drive-letter paths; browse from the drive root.
		const drive = /^\/[A-Za-z]:/.exec(remote.path);
		return remote.with({ path: drive ? `${drive[0]}/` : '/' });
	}
	return undefined;
}

const DOWNLOAD_BUTTON = {
	iconPath: new vscode.ThemeIcon('cloud-download'),
	tooltip: 'Download this directory',
};

/**
 * Browse the remote filesystem in a QuickPick.
 * Enter on a folder descends; Enter on a file or the "." row, or a
 * directory's download button, picks it.
 * Resolves to { uri, isDir } or undefined.
 */
function pickRemoteFile(startDir) {
	const qp = vscode.window.createQuickPick();
	qp.placeholder = 'Enter opens a folder or downloads a file';
	let dir = startDir;

	const load = async () => {
		qp.busy = true;
		qp.title = dir.path;
		const entries = await vscode.workspace.fs.readDirectory(dir);
		entries.sort(
			(a, b) =>
				(b[1] & vscode.FileType.Directory) - (a[1] & vscode.FileType.Directory) ||
				a[0].localeCompare(b[0])
		);
		qp.items = [
			{
				label: '$(folder-opened) .',
				description: 'download this directory',
				name: '.',
				isDir: true,
			},
			{ label: '$(arrow-up) ..', name: '..', isDir: true },
			...entries.map(([name, type]) => {
				const isDir = Boolean(type & vscode.FileType.Directory);
				return {
					label: `${isDir ? '$(folder)' : '$(file)'} ${name}`,
					name,
					isDir,
					buttons: isDir ? [DOWNLOAD_BUTTON] : [],
				};
			}),
		];
		qp.value = '';
		qp.busy = false;
	};

	return new Promise(resolve => {
		const pick = item => {
			resolve({
				uri: item.name === '.' ? dir : vscode.Uri.joinPath(dir, item.name),
				isDir: item.isDir,
			});
			qp.hide();
		};
		qp.onDidTriggerItemButton(e => pick(e.item));
		qp.onDidAccept(async () => {
			const item = qp.selectedItems[0];
			if (!item) {
				return;
			}
			if (!item.isDir || item.name === '.') {
				pick(item);
				return;
			}
			dir = vscode.Uri.joinPath(dir, item.name);
			await load();
		});
		qp.onDidHide(() => {
			resolve(undefined);
			qp.dispose();
		});
		load();
		qp.show();
	});
}

// ---------------------------------------------------------------------------
// Remote shell (tar backends)
// ---------------------------------------------------------------------------

const shQuote = s => `'${s.replace(/'/g, `'\\''`)}'`;

/** Run a shell command on the remote via a silent task; resolves to exit code. */
function runRemoteShell(command) {
	const name = `Simple Remote Download ${Math.random().toString(36).slice(2)}`;
	const task = new vscode.Task(
		{ type: 'shell' },
		vscode.TaskScope.Workspace,
		name,
		'simple-remote-download',
		new vscode.ShellExecution(command)
	);
	task.presentationOptions = {
		reveal: vscode.TaskRevealKind.Never,
		echo: false,
		focus: false,
		showReuseMessage: false,
		close: true,
	};
	return new Promise((resolve, reject) => {
		const sub = vscode.tasks.onDidEndTaskProcess(e => {
			if (e.execution.task.name === name) {
				sub.dispose();
				resolve(e.exitCode ?? -1);
			}
		});
		vscode.tasks.executeTask(task).catch(err => {
			sub.dispose();
			reject(err);
		});
	});
}

/** Cache of detected tools per remote authority, for the session. */
const toolsCache = new Map();

async function statOk(uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * The API never exposes the remote OS to a UI extension, so infer it from
 * filesystem shape over workspace.fs: drive-letter paths or a readable /C:/
 * mean Windows; /etc or /bin mean POSIX.
 */
async function detectRemoteOS(anyRemoteUri) {
	if (/^\/[A-Za-z]:(\/|$)/.test(anyRemoteUri.path)) {
		return 'windows';
	}
	if (
		(await statOk(anyRemoteUri.with({ path: '/etc' }))) ||
		(await statOk(anyRemoteUri.with({ path: '/bin' })))
	) {
		return 'posix';
	}
	if (await statOk(anyRemoteUri.with({ path: '/C:/' }))) {
		return 'windows';
	}
	return 'posix';
}

/**
 * Detect archive tools on the remote. POSIX only: runs a probe that writes
 * the names of available binaries to a remote temp file, then reads it back
 * over workspace.fs. Windows remotes and any failure (e.g. tasks
 * unavailable) yield the empty set, which hides the tar backends — zip and
 * plain copy are pure workspace.fs and work on any OS.
 */
async function detectRemoteTools(anyRemoteUri) {
	const cached = toolsCache.get(anyRemoteUri.authority);
	if (cached) {
		return cached;
	}
	if ((await detectRemoteOS(anyRemoteUri)) !== 'posix') {
		const none = new Set();
		toolsCache.set(anyRemoteUri.authority, none);
		return none;
	}
	const probe = `/tmp/srd-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	let tools;
	try {
		await runRemoteShell(
			`for b in tar gzip xz zstd; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done > ${probe}`
		);
		const uri = anyRemoteUri.with({ path: probe });
		try {
			const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString();
			tools = new Set(text.split('\n').filter(Boolean));
		} finally {
			await vscode.workspace.fs.delete(uri);
		}
	} catch {
		tools = new Set();
	}
	toolsCache.set(anyRemoteUri.authority, tools);
	return tools;
}

// ---------------------------------------------------------------------------
// Zip (built locally with fflate)
// ---------------------------------------------------------------------------

/** Recursively read a remote directory into an fflate zip map { name: data }. */
async function collectZipEntries(dirUri, prefix, progress, out = {}) {
	const list = await vscode.workspace.fs.readDirectory(dirUri);
	list.sort((a, b) => a[0].localeCompare(b[0]));
	for (const [name, type] of list) {
		const child = vscode.Uri.joinPath(dirUri, name);
		if (type & vscode.FileType.Directory) {
			out[`${prefix}${name}/`] = new Uint8Array(0);
			await collectZipEntries(child, `${prefix}${name}/`, progress, out);
		} else {
			progress.report({ message: prefix + name });
			out[prefix + name] = await vscode.workspace.fs.readFile(child);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Download command
// ---------------------------------------------------------------------------

function formatChoices(tools) {
	const tar = tools.has('tar');
	return [
		{ label: 'None', description: 'copy directory as-is', fmt: { ext: '', kind: 'copy' } },
		{ label: '.zip', description: 'built-in, compresses locally', fmt: { ext: '.zip', kind: 'zip' } },
		tar && { label: '.tar', description: 'remote tar', fmt: { ext: '.tar', kind: 'tar', flag: '' } },
		tar && tools.has('gzip') && { label: '.tar.gz', description: 'remote tar + gzip', fmt: { ext: '.tar.gz', kind: 'tar', flag: '-z' } },
		tar && tools.has('xz') && { label: '.tar.xz', description: 'remote tar + xz', fmt: { ext: '.tar.xz', kind: 'tar', flag: '-J' } },
		tar && tools.has('zstd') && { label: '.tar.zst', description: 'remote tar + zstd', fmt: { ext: '.tar.zst', kind: 'tar', flag: '--zstd' } },
	].filter(Boolean);
}

async function produce(source, fmt, dest, progress) {
	if (fmt.kind === 'copy') {
		await vscode.workspace.fs.copy(source, dest, { overwrite: true });
		return;
	}
	if (fmt.kind === 'zip') {
		const entries = await collectZipEntries(source, '', progress);
		await vscode.workspace.fs.writeFile(dest, zipSync(entries));
		return;
	}
	// tar on the remote into a temp file, then pull it down.
	const name = path.posix.basename(source.path);
	const parent = path.posix.dirname(source.path);
	const tmp = `/tmp/srd-${Date.now()}-${Math.random().toString(36).slice(2)}${fmt.ext}`;
	const cmd = ['tar', '-C', shQuote(parent), fmt.flag, '-cf', shQuote(tmp), shQuote(name)]
		.filter(Boolean)
		.join(' ');
	const exitCode = await runRemoteShell(cmd);
	if (exitCode !== 0) {
		throw new Error(`remote tar exited with code ${exitCode}`);
	}
	const tmpUri = source.with({ path: tmp });
	try {
		await vscode.workspace.fs.copy(tmpUri, dest, { overwrite: true });
	} finally {
		await vscode.workspace.fs.delete(tmpUri);
	}
}

async function downloadCommand() {
	const root = remoteRoot();
	if (!root) {
		vscode.window.showErrorMessage(
			'No remote connection found. Open any remote file or folder first.'
		);
		return;
	}

	const picked = await pickRemoteFile(root);
	if (!picked) {
		return;
	}
	const { uri: source, isDir } = picked;
	const baseName = path.posix.basename(source.path) || source.authority;

	let fmt = { ext: '', kind: 'copy' };
	if (isDir) {
		const tools = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Checking remote archive tools...',
			},
			() => detectRemoteTools(source)
		);
		const chosen = await vscode.window.showQuickPick(formatChoices(tools), {
			title: `Download format for ${baseName}`,
			placeHolder: 'Select a format',
		});
		if (!chosen) {
			return;
		}
		fmt = chosen.fmt;
	}

	const fileName = baseName + fmt.ext;
	const destination = await vscode.window.showSaveDialog({
		// file: scheme => native local save dialog, even in a remote window.
		defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', fileName)),
		saveLabel: 'Download',
		title: `Download ${fileName}`,
	});
	if (!destination) {
		return;
	}

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Downloading ${fileName}...`,
			},
			progress => produce(source, fmt, destination, progress)
		);
	} catch (err) {
		vscode.window.showErrorMessage(
			`Download failed: ${err instanceof Error ? err.message : String(err)}`
		);
		return;
	}

	const reveal = 'Reveal in Finder';
	const choice = await vscode.window.showInformationMessage(
		`Downloaded to ${destination.fsPath}`,
		reveal
	);
	if (choice === reveal) {
		await vscode.commands.executeCommand('revealFileInOS', destination);
	}
}

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('simpleRemoteDownload.download', downloadCommand)
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
