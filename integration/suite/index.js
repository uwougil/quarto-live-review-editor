const assert = require('node:assert/strict');
const vscode = require('vscode');

module.exports.run = async function run() {
	const extension = vscode.extensions.getExtension('t-shoot.markdown-live-preview-editor');
	assert.ok(extension, 'the Markdown Live Preview extension was not installed in the test host');
	await extension.activate();

	const report = await vscode.commands.executeCommand('mdLivePreview.__testDocumentSync');
	assert.equal(report.dirtyAfterEdit, true);
	assert.equal(report.siblingUnchangedBeforeSave, true);
	assert.ok(report.savedSnapshotCount >= 4, `expected save snapshots, got ${report.savedSnapshotCount}`);
	assert.ok(report.externalUpdateCount >= 2, `expected source-editor updates, got ${report.externalUpdateCount}`);
	assert.equal(report.saveFailureBroadcastCount, 0);
	assert.ok(report.finalText.endsWith('SF'), `unexpected final host text: ${report.finalText}`);
};
