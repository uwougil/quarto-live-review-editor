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
	assert.equal(report.staleScenarioCount, 5);
	assert.ok(report.staleResyncCount >= 5, `expected stale-base resyncs, got ${report.staleResyncCount}`);
	assert.ok(report.staleRetryCount >= 5, `expected stale edit retries, got ${report.staleRetryCount}`);
	assert.equal(report.staleSaveFailureBroadcastCount, 0);
	assert.ok(report.staleFinalText.endsWith('345uvwRrEF'), `unexpected stale-sibling final text: ${report.staleFinalText}`);
	assert.equal(report.hostSaveScenarioCount, 4);
	assert.ok(report.hostSaveBarrierCount >= 8, `expected host-side save barriers, got ${report.hostSaveBarrierCount}`);
	assert.equal(report.hostSaveFailureBroadcastCount, 0);
	assert.ok(report.hostSaveFinalText.endsWith('H1H2Q1S1S2F1F2'), `unexpected host-save final text: ${report.hostSaveFinalText}`);
};
