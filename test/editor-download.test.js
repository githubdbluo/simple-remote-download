const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

class Uri {
	constructor(value) {
		this.value = value;
		const url = new URL(value);
		this.scheme = url.protocol.slice(0, -1);
		this.authority = url.host;
		this.path = decodeURIComponent(url.pathname);
		this.fsPath = this.path;
	}
	toString() { return this.value; }
	static file(value) { return new Uri(pathToFileURL(value).href); }
	static joinPath(base, name) { return new Uri(base.toString().replace(/\/$/, '') + '/' + name); }
}
const remote = new Uri('vscode-remote://ssh-remote+test/root/outside/报告.xlsx');
const active = new Uri('vscode-remote://ssh-remote+test/workspace/active.txt');

function setup() {
	const commands = new Map();
	const calls = { copies: [], errors: [], dialogs: [], browses: 0 };
	const vscode = {
		Uri, FileType: { File: 1, Directory: 2 },
		ThemeIcon: class ThemeIcon {}, ProgressLocation: { Notification: 15 },
		commands: {
			registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; },
			executeCommand: async () => {}
		},
		workspace: {
			workspaceFolders: [{ uri: new Uri('vscode-remote://ssh-remote+test/workspace') }],
			textDocuments: [], fs: {
				stat: async () => ({ type: 1 }),
				readDirectory: async () => [['chosen.xlsx', 1]],
				copy: async (...args) => calls.copies.push(args)
			}
		},
		window: {
			tabGroups: { all: [], activeTabGroup: { activeTab: { input: { uri: active } } } },
			showSaveDialog: async options => {
				calls.dialogs.push(options); return Uri.file(path.join(process.cwd(), 'saved.xlsx'));
			},
			showInformationMessage: async () => undefined,
			showWarningMessage: async () => undefined,
			showErrorMessage: async message => calls.errors.push(message),
			withProgress: async (_, task) => task({ report() {} }),
			createQuickPick: () => {
				calls.browses++;
				let accept, hide;
				return {
					onDidTriggerItemButton() {}, onDidAccept(fn) { accept = fn; },
					onDidHide(fn) { hide = fn; }, dispose() {}, hide() { hide(); },
					show() { this.selectedItems = [{ name: 'chosen.xlsx', isDir: false }]; accept(); }
				};
			}
		}
	};
	const sandbox = { module: { exports: {} }, Buffer,
		require: name => name === 'vscode' ? vscode : name === 'fflate' ? {} : require(name) };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8'), sandbox);
	sandbox.module.exports.activate({ subscriptions: [] });
	return { vscode, calls, download: commands.get('simpleRemoteDownload.downloadEditorFile'),
		browse: commands.get('simpleRemoteDownload.download') };
}

test('inactive custom-editor tab downloads its URI outside the workspace without browsing', async () => {
	const { download, calls } = setup();
	await download(remote, { groupId: 99, editorIndex: 0 });
	assert.equal(calls.copies[0][0], remote);
	assert.equal(calls.dialogs[0].defaultUri.scheme, 'file');
	assert.equal(calls.browses, 0);
	assert.equal(calls.errors.length, 0);
});

test('command palette uses an active file-backed custom editor', async () => {
	const { download, calls, vscode } = setup();
	vscode.window.tabGroups.activeTabGroup.activeTab.input = { uri: remote, viewType: 'xlsx.editor' };
	await download();
	assert.equal(calls.copies[0][0], remote);
});

test('local files, resource-less tabs and malformed menu arguments are rejected', async () => {
	const { download, calls, vscode } = setup();
	await download(Uri.file(path.join(process.cwd(), 'local.txt')));
	await download({ groupId: 10 });
	vscode.window.tabGroups.activeTabGroup.activeTab.input = { original: remote, modified: active };
	await download();
	assert.equal(calls.errors.length, 3);
	assert.equal(calls.copies.length, 0);
});

test('directories are rejected by the file-tab command', async () => {
	const { download, calls, vscode } = setup();
	vscode.workspace.fs.stat = async () => ({ type: 2 });
	await download(remote);
	assert.equal(calls.dialogs.length, 0);
	assert.match(calls.errors[0], /directory/);
});

test('missing remote file errors are shown without an unhandled rejection', async () => {
	const { download, calls, vscode } = setup();
	vscode.workspace.fs.stat = async () => { throw new Error('FileNotFound'); };
	await download(remote);
	assert.match(calls.errors[0], /FileNotFound/);
	assert.equal(calls.dialogs.length, 0);
});

test('cancelling the save dialog performs no transfer', async () => {
	const { download, calls, vscode } = setup();
	vscode.window.showSaveDialog = async () => undefined;
	await download(remote);
	assert.equal(calls.copies.length, 0);
});

test('dirty custom editor cancellation performs no transfer', async () => {
	const { download, calls, vscode } = setup();
	vscode.window.tabGroups.all = [{ tabs: [{ isDirty: true, input: { uri: remote } }] }];
	await download(remote);
	assert.equal(calls.dialogs.length, 0);
	assert.equal(calls.copies.length, 0);
});

test('dirty custom editor can explicitly download its saved version', async () => {
	const { download, calls, vscode } = setup();
	vscode.window.tabGroups.all = [{ tabs: [{ isDirty: true, input: { uri: remote } }] }];
	vscode.window.showWarningMessage = async () => 'Download Saved Version';
	await download(remote);
	assert.equal(calls.copies[0][0], remote);
});

test('existing command still browses and downloads the selected file', async () => {
	const { browse, calls } = setup();
	await browse();
	assert.equal(calls.browses, 1);
	assert.equal(calls.copies[0][0].path, '/workspace/chosen.xlsx');
});
