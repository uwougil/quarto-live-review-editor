import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localCode = process.env.MLP_VSCODE_EXECUTABLE
	?? (process.platform === 'win32'
		? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')
		: undefined);

const options = {
	extensionDevelopmentPath: root,
	extensionTestsPath: path.resolve(root, 'integration', 'suite'),
	launchArgs: ['--disable-gpu', '--skip-welcome', '--skip-release-notes'],
};
if (localCode && fs.existsSync(localCode)) options.vscodeExecutablePath = localCode;
else options.version = '1.90.0';

await runTests(options);
