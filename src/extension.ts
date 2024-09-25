import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as fs from 'fs';

let remoteHosts: string[] = [];
let currentHost: string | undefined;
let lastSyncExecutionTime: number | undefined;
let statusBarItem: vscode.StatusBarItem;
enum SyncState {
	Init = 'init',
	Synced = 'synced',
	Syncing = 'syncing',
	Error = 'error'
}

enum DeletionMode {
	Off = 'off',
	Once = 'once',
	On = 'on'
}
let deletionMode: DeletionMode = DeletionMode.Off;


export function activate(context: vscode.ExtensionContext) {

	console.log('codemirror: extension activated');

	// Load saved remoteHosts and lastUsedHost from storage
	remoteHosts = context.globalState.get('remoteHosts', []);
	currentHost = context.workspaceState.get('lastUsedHost', undefined);

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	context.subscriptions.push(statusBarItem);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('codemirror.SelectHost', () => promptSelectHost(context)),
		vscode.commands.registerCommand('codemirror.AddHost', () => promptAddHost(context)),
		vscode.commands.registerCommand('codemirror.RemoveHost', () => promptRemoveHost(context))
	);

	// Register a file system watcher
	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	watcher.onDidChange((uri) => {
		if (uri.scheme === 'file') {
			runSyncCommand();
		}
	});
	context.subscriptions.push(watcher);


	// Make the status bar item clickable
	statusBarItem.command = 'codemirror.SelectHost';

	updateStatusBar(SyncState.Init);
}


function runSyncCommand(): Promise<{ success: boolean, message?: string }> {
	return new Promise((resolve) => {

		if (!currentHost || currentHost.trim() === '') {
			updateStatusBar(SyncState.Init);
			resolve({ success: false, message: 'no remote host selected' });
			return;
		}

		updateStatusBar(SyncState.Syncing);

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('codemirror: no workspace folder found');
			updateStatusBar(SyncState.Error);
			resolve({ success: false, message: 'no workspace folder found' });
			return;
		}


		updateStatusBar(SyncState.Syncing);

		const gitignorePath = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore');
		let excludeFromOption = '';

		// Check if .gitignore exists
		if (fs.existsSync(gitignorePath.fsPath)) {
			excludeFromOption = `--exclude-from=${gitignorePath.fsPath}`;
		}

		const dest_path = currentHost.endsWith('/') ? currentHost : `${currentHost}/`;

		// https://stackoverflow.com/questions/13713101/rsync-exclude-according-to-gitignore-hgignore-svnignore-like-filter-c
		const command = `rsync -avzh \
			${deletionMode !== 'off' ? '--delete-after ' : ''}\
			--include='**.gitignore' --exclude='/.git' --filter=':- .gitignore' \
			--out-format='change: %n' \
			${workspaceFolder.uri.fsPath} ${dest_path}`;

		const startTime = Date.now();
		exec(command, { cwd: workspaceFolder.uri.fsPath }, (error, stdout, stderr) => {
			const endTime = Date.now();
			const executionTime = endTime - startTime;

			if (error) {
				vscode.window.showErrorMessage(`codemirror error: ${error.message}`);
				updateStatusBar(SyncState.Error);
				resolve({ success: false, message: error.message });
				return;
			}

			if (stderr) {
				vscode.window.showErrorMessage(`codemirror stderr: ${stderr}`);
				updateStatusBar(SyncState.Error);
				resolve({ success: false, message: stderr });
				return;
			}

			if (deletionMode === DeletionMode.Once) {
				deletionMode = DeletionMode.Off;
			}

			// parse deleted files
			const deletedFiles = stdout.split('\n').filter(line => line.startsWith('delete:'));
			deletedFiles.forEach(line => {
				console.log(line);
			});

			// parse changed files
			const changedLines = stdout.split('\n').filter(line => line.startsWith('change:'));
			console.log(`Made ${changedLines.length} changes at ${new Date(endTime).toLocaleTimeString()} in ${executionTime}ms`);
			changedLines.forEach(line => {
				// strip the "change: " prefix
				const fileName = line.substring(8).trim();
				console.log(fileName);
			});

			updateStatusBar(SyncState.Synced, startTime, executionTime);
			resolve({
				success: true,
				message: `Synced ${changedLines.length} files in ${executionTime}ms`
			});
		});

	});
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (statusBarItem) {
		statusBarItem.dispose();
	}
}

function setHost(context: vscode.ExtensionContext, host: string) {
	currentHost = host
	runSyncCommand().then(result => {
		if (result.success) {
			context.workspaceState.update('lastUsedHost', host);
		}
	});
}


function promptDeletionMode() {
	vscode.window.showQuickPick(['Once', 'On', 'Off']).then(selection => {
		if (selection) {
			deletionMode = selection.toLowerCase() as DeletionMode;
			updateStatusBar();
		}
	});
}


function promptRemoveHost(context: vscode.ExtensionContext) {
	vscode.window.showQuickPick(remoteHosts, {
		placeHolder: 'Select host to remove'
	}).then(hostToRemove => {
		if (hostToRemove) {
			// if the host to remove is the current host, reset it
			if (hostToRemove === currentHost) {
				currentHost = undefined;
				updateStatusBar(SyncState.Init);
			}
			remoteHosts = remoteHosts.filter(host => host !== hostToRemove);
			context.globalState.update('remoteHosts', remoteHosts);
			vscode.window.showInformationMessage(`Removed host: ${hostToRemove}`);
		}
	});
}


// really more of an onClick
function promptSelectHost(context: vscode.ExtensionContext) {
	const options: vscode.QuickPickItem[] = [
		{ label: '$(stop) Disable Sync' }
	];
	options.push(...remoteHosts.map(host => ({
		label: host,
		picked: host === currentHost
	})));
	options.push({ label: '$(plus) Add New Host' });
	options.push({ label: '$(flame) Deletion Mode' });
	options.push({ label: '$(trash) Remove Host' });
	vscode.window.showQuickPick(options, {
		placeHolder: 'Select codemirror remote',
		ignoreFocusOut: true
	}).then(selection => {
		if (selection) {
			if (selection.label === '$(plus) Add New Host') {
				promptAddHost(context);
			} else if (selection.label === '$(flame) Deletion Mode') {
				promptDeletionMode();
			} else if (selection.label === '$(trash) Remove Host') {
				promptRemoveHost(context);
			} else if (selection.label === '$(stop) Disable Sync') {
				currentHost = undefined;
				context.workspaceState.update('lastUsedHost', undefined);
				updateStatusBar(SyncState.Init);
			} else {
				setHost(context, selection.label);
			}
		}
	});
}

function validateHost(host: string, testReachability: boolean = true): Promise<boolean> {
	const parts = host.split(':');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		vscode.window.showErrorMessage(`codemirror: Invalid host format. Please use 'hostname:path'`);
		return Promise.resolve(false);
	}

	if (testReachability) {
		const [hostname, path] = parts;
		const command = `ssh ${hostname} -t "ls ${path}"`;
		return new Promise<boolean>((resolve) => {
			exec(command, (error, stdout, stderr) => {
				if (error) {
					vscode.window.showErrorMessage(`codemirror: Cannot access remote path: ${error.message}`);
					resolve(false);
				} else {
					resolve(true);
				}
			});
		});
	} else {
		return Promise.resolve(true);
	}
}



function promptAddHost(context: vscode.ExtensionContext) {
	vscode.window.showInputBox({ prompt: 'Enter new remote host', placeHolder: 'hostname:path' }).then(newHost => {
		if (newHost) {
			// Confirm that the host is reachable
			validateHost(newHost, true).then(isValid => {
				if (!isValid) {
					return;
				}

				if (remoteHosts.includes(newHost)) {
					vscode.window.showWarningMessage(`codemirror: Host ${newHost} already exists, ignoring.`);
					return;
				}

				remoteHosts.push(newHost);
				// Save updated remoteHosts to storage
				context.globalState.update('remoteHosts', remoteHosts);
				vscode.window.showInformationMessage(`codemirror: Added new host: ${newHost}`);
				setHost(context, newHost);
			});
		}
	});
}



function updateStatusBar(newState?: SyncState, timestamp?: number, executionTime?: number) {

	if (executionTime !== undefined) {
		lastSyncExecutionTime = executionTime;
	}

	const hoverMessage = new vscode.MarkdownString();
	hoverMessage.appendMarkdown(`**codemirror**\n\n`);
	hoverMessage.appendMarkdown(`**Target:** ${currentHost || 'Not set'}\n\n`);
	hoverMessage.appendMarkdown(`**Deletion Mode:** ${deletionMode}\n\n`);
	hoverMessage.appendMarkdown(`**Last Sync Latency:** ${lastSyncExecutionTime ? `${lastSyncExecutionTime}ms` : 'N/A'}\n\n`);

	switch (newState) {
		case SyncState.Init:
			statusBarItem.text = `[select host]`;
			statusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
			break;
		case SyncState.Synced:
			statusBarItem.text = `$(check) ${timestamp ? new Date(timestamp).toLocaleTimeString() : ''}`;
			statusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
			break;
		case SyncState.Syncing:
			const startTime = Date.now();
			statusBarItem.text = `$(sync) ${new Date(startTime).toLocaleTimeString()}`;
			statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningBackground');
			break;
		case SyncState.Error:
			statusBarItem.text = `$(error) Error`;
			statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
			break;
	}

	if (deletionMode != DeletionMode.Off) {
		statusBarItem.text += ` $(flame)`;
	}

	statusBarItem.tooltip = hoverMessage;
	statusBarItem.show();
}
