#!/usr/bin/env node
// Register the bridge to start when the user signs in, listening on
// 127.0.0.1:8787. Windows uses a logon scheduled task. macOS uses a LaunchAgent.
//
// The process has to run as the signed-in user: that is the account whose
// browser holds the Gemini Enterprise tab. A boot service that starts before
// sign-in would be up with nobody to talk to.
//
//   npm run autostart
//   npm run autostart -- status
//   npm run autostart -- uninstall
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const serverFile = path.join(here, 'bridge', 'server.mjs');
const nodeBin = process.execPath;

const TASK_NAME = 'AiPASS Enterprise Bridge';
const LABEL = 'com.aipass.enterprise-bridge';
const HOST = process.env.AIPASS_HOST || '127.0.0.1';
const PORT = String(process.env.AIPASS_PORT || '8787');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const command = argv.find((arg) => !arg.startsWith('--')) ?? 'install';

if (argv.includes('--help') || argv.includes('-h') || command === 'help') {
  console.log(`usage: npm run autostart [-- status | uninstall] [--dry-run]

  install     start the bridge on ${HOST}:${PORT} at every sign-in (default)
  status      say whether that sign-in start is registered
  uninstall   remove it

Windows registers a task that runs at logon. macOS writes a LaunchAgent.
The node binary used is the one running this command, so sign-in does not
depend on a login PATH.

  AIPASS_HOST   interface to bind   (default: 127.0.0.1)
  AIPASS_PORT   port to bind        (default: 8787)`);
  process.exit(0);
}

const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function run(file, args, { allowFail = false } = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  if (!allowFail && result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${file} ${args.join(' ')} failed (${result.status}): ${detail}`);
  }
  return result;
}

function portInUse(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

function windowsPaths() {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'aipass-enterprise-bridge');
  return {
    base,
    launcher: path.join(base, 'start-bridge.cmd'),
    taskXml: path.join(base, 'task.xml'),
    log: path.join(base, 'bridge.log'),
  };
}

function windowsUser() {
  const fromEnv = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
  try {
    const queried = spawnSync('whoami', { encoding: 'utf8' });
    const name = (queried.stdout || '').trim();
    if (queried.status === 0 && name) return name;
  } catch { /* fall through to the environment */ }
  if (!fromEnv) throw new Error('could not determine the Windows user for the logon task');
  return fromEnv;
}

function windowsLauncher(logFile) {
  return [
    '@echo off',
    'setlocal',
    `set "AIPASS_HOST=${HOST}"`,
    `set "AIPASS_PORT=${PORT}"`,
    `cd /d "${repoRoot}"`,
    `echo ---- %DATE% %TIME% starting %AIPASS_HOST%:%AIPASS_PORT% ---- >> "${logFile}"`,
    `"${nodeBin}" "${serverFile}" >> "${logFile}" 2>&1`,
    '',
  ].join('\r\n');
}

function windowsTaskXml(userId, launcher) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the AiPASS Enterprise bridge on ${xmlEscape(HOST)}:${xmlEscape(PORT)} when you sign in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(launcher)}</Command>
      <WorkingDirectory>${xmlEscape(repoRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function macPaths() {
  const home = os.homedir();
  return {
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: path.join(home, 'Library', 'Logs', 'aipass-enterprise-bridge', 'bridge.log'),
  };
}

function macPlist(logFile) {
  const args = [nodeBin, serverFile].map((value) => `    <string>${xmlEscape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIPASS_HOST</key>
    <string>${xmlEscape(HOST)}</string>
    <key>AIPASS_PORT</key>
    <string>${xmlEscape(PORT)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

function describe(lines) {
  console.log(lines.filter(Boolean).join('\n'));
}

function unsupported() {
  describe([
    dryRun ? 'autostart install (dry run)' : '',
    'This command registers a sign-in start on Windows and macOS.',
    'On Linux, run `npm run dev` under systemd, or use aipass-bridge/deploy.',
  ]);
}

async function install() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    unsupported();
    process.exit(dryRun ? 0 : 1);
  }
  const busy = await portInUse(PORT, HOST);
  if (process.platform === 'win32') {
    const paths = windowsPaths();
    const user = windowsUser();
    describe([
      dryRun ? 'autostart install (dry run)' : 'autostart install',
      `platform: win32`,
      `when: at sign-in`,
      `task: ${TASK_NAME}`,
      `user: ${user}`,
      `node: ${nodeBin}`,
      `server: ${serverFile}`,
      `listen: ${HOST}:${PORT}`,
      `log: ${paths.log}`,
    ]);
    if (dryRun) return;
    fs.mkdirSync(paths.base, { recursive: true });
    fs.writeFileSync(paths.launcher, windowsLauncher(paths.log));
    fs.writeFileSync(paths.taskXml, `\ufeff${windowsTaskXml(user, paths.launcher)}`, 'utf16le');
    run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', paths.taskXml, '/F']);
    if (busy) {
      console.log(`\n${HOST}:${PORT} is already in use. The task is registered and will start the bridge at the next sign-in.`);
      return;
    }
    run('schtasks', ['/Run', '/TN', TASK_NAME]);
    console.log(`\nBridge starting on http://${HOST}:${PORT}`);
    return;
  }

  const paths = macPaths();
  const domain = `gui/${process.getuid()}`;
  describe([
    dryRun ? 'autostart install (dry run)' : 'autostart install',
    'platform: darwin',
    'when: at sign-in',
    `label: ${LABEL}`,
    `plist: ${paths.plist}`,
    `node: ${nodeBin}`,
    `server: ${serverFile}`,
    `listen: ${HOST}:${PORT}`,
    `log: ${paths.log}`,
  ]);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
  fs.mkdirSync(path.dirname(paths.log), { recursive: true });
  fs.writeFileSync(paths.plist, macPlist(paths.log));
  run('launchctl', ['bootout', `${domain}/${LABEL}`], { allowFail: true });
  if (busy) {
    console.log(`\n${HOST}:${PORT} is already in use. The LaunchAgent is installed and will start the bridge at the next sign-in.`);
    return;
  }
  const boot = run('launchctl', ['bootstrap', domain, paths.plist], { allowFail: true });
  if (boot.status !== 0) {
    run('launchctl', ['load', '-w', paths.plist]);
  }
  console.log(`\nBridge starting on http://${HOST}:${PORT}`);
}

function status() {
  if (process.platform === 'win32') {
    const queried = run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { allowFail: true });
    const paths = windowsPaths();
    if (queried.status !== 0) {
      console.log(`${TASK_NAME} is not registered.`);
      console.log('Install it with: npm run autostart');
      return;
    }
    console.log(queried.stdout.trim());
    console.log(`log: ${paths.log}`);
    return;
  }
  if (process.platform === 'darwin') {
    const paths = macPaths();
    const printed = run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { allowFail: true });
    if (printed.status !== 0) {
      const installed = fs.existsSync(paths.plist);
      console.log(installed
        ? `${LABEL} is installed at ${paths.plist} and will load at the next sign-in.`
        : `${LABEL} is not installed.`);
      if (!installed) console.log('Install it with: npm run autostart');
      return;
    }
    console.log(`${LABEL} is loaded.`);
    console.log(`plist: ${paths.plist}`);
    console.log(`log: ${paths.log}`);
    return;
  }
  unsupported();
  process.exit(1);
}

function uninstall() {
  if (process.platform === 'win32') {
    const paths = windowsPaths();
    describe([
      dryRun ? 'autostart uninstall (dry run)' : 'autostart uninstall',
      `task: ${TASK_NAME}`,
      `launcher: ${paths.launcher}`,
    ]);
    if (dryRun) return;
    run('schtasks', ['/End', '/TN', TASK_NAME], { allowFail: true });
    const removed = run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { allowFail: true });
    for (const file of [paths.launcher, paths.taskXml]) {
      fs.rmSync(file, { force: true });
    }
    console.log(removed.status === 0 ? 'Removed the sign-in task.' : 'No sign-in task was registered.');
    return;
  }
  if (process.platform === 'darwin') {
    const paths = macPaths();
    const domain = `gui/${process.getuid()}`;
    describe([
      dryRun ? 'autostart uninstall (dry run)' : 'autostart uninstall',
      `label: ${LABEL}`,
      `plist: ${paths.plist}`,
    ]);
    if (dryRun) return;
    run('launchctl', ['bootout', `${domain}/${LABEL}`], { allowFail: true });
    run('launchctl', ['unload', '-w', paths.plist], { allowFail: true });
    fs.rmSync(paths.plist, { force: true });
    console.log('Removed the sign-in LaunchAgent.');
    return;
  }
  unsupported();
  process.exit(1);
}

try {
  if (command === 'install') await install();
  else if (command === 'status') status();
  else if (command === 'uninstall' || command === 'remove') uninstall();
  else {
    console.error(`unknown command: ${command}`);
    console.error('usage: npm run autostart [-- status | uninstall]');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
