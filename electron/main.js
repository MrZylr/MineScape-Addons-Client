const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs/promises');
const fss = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CONFIG = {
  clientName: 'MineScape Addons',
  launcherVersion: '1',
  minecraftVersion: '26.1.2',
  fabricLoaderSelection: 'auto-stable',
  offlineDevLaunchEnabled: false,
  offlineDevUsername: 'Zylr',
  microsoftTenant: 'consumers',
  microsoftClientId: '82a8de73-26a7-4b07-b497-5fc25dd66496',
  microsoftScope: 'XboxLive.signin XboxLive.offline_access openid profile offline_access',
  minecraftAuthApproved: true,
  userAgent: 'MineScape AddonsLauncher/1.0'
};

const LAUNCHER_UPDATE_URL = 'https://github.com/MrZylr/MineScape-Addons-Client';

const roots = {
  working: path.join(os.homedir(), '.minescape_addons'),
  runtime: path.join(os.homedir(), '.minescape_addons', 'runtime'),
  metadata: path.join(os.homedir(), '.minescape_addons', 'metadata'),
  instances: path.join(os.homedir(), '.minescape_addons', 'instances')
};

const state = {
  win: null,
  resolvedVersion: null,
  sessions: [],
  activeUsername: '',
  login: null,
  prepareInProgress: false,
  defaultResources: {
    checked: false,
    remoteVersion: '',
    localVersion: '',
    prepareRequired: false
  }
};

function assetPath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, ...parts);
}

function instanceDirectory() {
  const session = activeSession();
  const id = state.activeUsername || session?.username || (CONFIG.offlineDevLaunchEnabled ? CONFIG.offlineDevUsername : 'default');
  const sanitized = String(id || 'default').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\-.]+|[_\-.]+$/g, '') || 'default';
  return path.join(roots.instances, sanitized);
}

function send(channel, value) {
  state.win?.webContents.send(channel, value);
}

function status(message) {
  send('status', message);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function mkdir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function download(url, target, headers = {}) {
  if (await exists(target) && !headers.force) return target;
  await mkdir(path.dirname(target));
  const { force, ...requestHeaders } = headers;
  const res = await fetch(url, { headers: requestHeaders });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const temp = path.join(os.tmpdir(), `minescape-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, Buffer.from(await res.arrayBuffer()));
  await fs.rename(temp, target);
  return target;
}

async function loadSessions() {
  const file = path.join(roots.metadata, 'account-sessions.json');
  const data = await readJson(file, { sessions: [], activeUsername: '' });
  state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  state.activeUsername = data.activeUsername || state.sessions[0]?.username || '';
}

async function saveSessions() {
  await mkdir(roots.metadata);
  await fs.writeFile(path.join(roots.metadata, 'account-sessions.json'), JSON.stringify({
    tokenStorage: 'electron-local-json',
    activeUsername: state.activeUsername,
    sessions: state.sessions
  }, null, 2));
}

function activeSession() {
  return state.sessions.find(s => s.username?.toLowerCase() === state.activeUsername?.toLowerCase()) || state.sessions[0] || null;
}

async function upsertSession(session) {
  state.sessions = state.sessions.filter(s => s.username.toLowerCase() !== session.username.toLowerCase());
  state.sessions.push(session);
  state.sessions.sort((a, b) => a.username.localeCompare(b.username));
  state.activeUsername = session.username;
  await saveSessions();
}

async function resolveVersion() {
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
    headers: { Accept: 'application/json' }
  });
  const version = manifest.versions.find(v => v.id === CONFIG.minecraftVersion);
  if (!version) throw new Error(`Minecraft version ${CONFIG.minecraftVersion} was not found in the official Mojang manifest.`);
  const loaders = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${CONFIG.minecraftVersion}`);
  const loader = CONFIG.fabricLoaderSelection === 'auto-stable'
    ? loaders.find(entry => entry.loader?.stable)?.loader
    : loaders.find(entry => entry.loader?.version === CONFIG.fabricLoaderSelection)?.loader;
  if (!loader) throw new Error(`Fabric does not currently expose a loader for Minecraft ${CONFIG.minecraftVersion}.`);
  const fabricProfileUrl = `https://meta.fabricmc.net/v2/versions/loader/${CONFIG.minecraftVersion}/${loader.version}/profile/json`;
  const versionJson = await fetchJson(version.url);
  const fabricJson = await fetchJson(fabricProfileUrl);
  state.resolvedVersion = {
    minecraftVersion: CONFIG.minecraftVersion,
    minecraftManifestUrl: version.url,
    fabricLoaderVersion: loader.version,
    fabricProfileUrl,
    fabricMainClass: fabricJson.mainClass || '',
    minJavaVersion: loader.min_java_version || 8,
    minecraftJavaVersion: versionJson.javaVersion?.majorVersion || 8
  };
  await mkdir(roots.metadata);
  await fs.writeFile(path.join(roots.metadata, 'resolved-version.txt'), Object.entries({
    minecraft_version: state.resolvedVersion.minecraftVersion,
    minecraft_manifest_url: state.resolvedVersion.minecraftManifestUrl,
    fabric_loader_version: state.resolvedVersion.fabricLoaderVersion,
    fabric_profile_url: state.resolvedVersion.fabricProfileUrl,
    fabric_main_class: state.resolvedVersion.fabricMainClass,
    min_java_version: state.resolvedVersion.minJavaVersion,
    minecraft_java_version: state.resolvedVersion.minecraftJavaVersion
  }).map(([k, v]) => `${k}=${v}`).join('\n'));
  return state.resolvedVersion;
}

async function readResolvedVersion() {
  if (state.resolvedVersion) return state.resolvedVersion;
  try {
    const lines = (await fs.readFile(path.join(roots.metadata, 'resolved-version.txt'), 'utf8')).split(/\r?\n/);
    const values = Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]).filter(([k]) => k));
    if (values.minecraft_version && values.fabric_loader_version) {
      state.resolvedVersion = {
        minecraftVersion: values.minecraft_version,
        minecraftManifestUrl: values.minecraft_manifest_url,
        fabricLoaderVersion: values.fabric_loader_version,
        fabricProfileUrl: values.fabric_profile_url,
        fabricMainClass: values.fabric_main_class,
        minJavaVersion: Number(values.min_java_version || 8),
        minecraftJavaVersion: Number(values.minecraft_java_version || 8)
      };
    }
  } catch {}
  return state.resolvedVersion;
}

function allowedOnWindows(library) {
  if (!Array.isArray(library.rules) || library.rules.length === 0) return true;
  let allowed = false;
  for (const rule of library.rules) {
    const osRule = rule.os || {};
    if (osRule.name && osRule.name !== 'windows') continue;
    allowed = rule.action === 'allow' ? true : rule.action === 'disallow' ? false : allowed;
  }
  return allowed;
}

function mavenPath(coordinate) {
  const [group, artifact, version, classifier] = coordinate.split(':');
  if (!group || !artifact || !version) return '';
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
}

function artifactTarget(relativePath) {
  return path.join(roots.runtime, 'libraries', ...relativePath.split('/'));
}

async function prepareRuntime() {
  const resolved = await readResolvedVersion();
  if (!resolved) throw new Error('Runtime preparation requires resolved version metadata first.');
  const versionDir = path.join(roots.runtime, 'versions', resolved.minecraftVersion);
  const assetsDir = path.join(roots.runtime, 'assets');
  const nativesDir = path.join(roots.runtime, 'natives', resolved.minecraftVersion);
  await Promise.all([
    mkdir(versionDir), mkdir(path.join(assetsDir, 'indexes')), mkdir(path.join(assetsDir, 'objects')),
    mkdir(path.join(assetsDir, 'log_configs')), mkdir(nativesDir), mkdir(roots.metadata)
  ]);
  const versionJson = await fetchJson(resolved.minecraftManifestUrl);
  const fabricJson = await fetchJson(resolved.fabricProfileUrl);
  await fs.writeFile(path.join(roots.metadata, `${resolved.minecraftVersion}.json`), JSON.stringify(versionJson, null, 2));
  await fs.writeFile(path.join(roots.metadata, `fabric-${resolved.fabricLoaderVersion}-${resolved.minecraftVersion}.json`), JSON.stringify(fabricJson, null, 2));

  const clientJar = await download(versionJson.downloads.client.url, path.join(versionDir, `${resolved.minecraftVersion}.jar`));
  const assetIndex = versionJson.assetIndex;
  const assetIndexPath = await download(assetIndex.url, path.join(assetsDir, 'indexes', `${assetIndex.id}.json`));
  const loggingFile = versionJson.logging?.client?.file;
  const loggingPath = loggingFile?.url
    ? await download(loggingFile.url, path.join(assetsDir, 'log_configs', loggingFile.id))
    : '';

  const index = await readJson(assetIndexPath, { objects: {} });
  for (const object of Object.values(index.objects || {})) {
    if (!object.hash || object.hash.length < 2) continue;
    await download(`https://resources.download.minecraft.net/${object.hash.slice(0, 2)}/${object.hash}`,
      path.join(assetsDir, 'objects', object.hash.slice(0, 2), object.hash));
  }

  const classpath = [];
  const nativeJars = [];
  for (const lib of versionJson.libraries || []) {
    if (!allowedOnWindows(lib)) continue;
    const artifact = lib.downloads?.artifact;
    if (artifact?.path && artifact?.url) {
      const target = await download(artifact.url, artifactTarget(artifact.path));
      if ((lib.name || '').includes(':natives-windows')) nativeJars.push(target);
      else classpath.push(target);
    }
    for (const classifier of Object.values(lib.downloads?.classifiers || {})) {
      if (classifier?.path && classifier?.url) {
        const target = await download(classifier.url, artifactTarget(classifier.path));
        if (classifier.path.includes('natives-windows')) nativeJars.push(target);
      }
    }
  }
  for (const lib of fabricJson.libraries || []) {
    const rel = mavenPath(lib.name || '');
    if (rel && lib.url) classpath.push(await download(`${lib.url.replace(/\/$/, '')}/${rel}`, artifactTarget(rel)));
  }
  for (const jar of nativeJars) {
    spawnSync('tar', ['-xf', jar, '-C', nativesDir], { windowsHide: true });
  }
  classpath.push(clientJar);
  await fs.writeFile(path.join(roots.metadata, `classpath-${resolved.minecraftVersion}.txt`), classpath.join('\n'));
  await fs.writeFile(path.join(roots.metadata, `runtime-${resolved.minecraftVersion}.txt`), [
    `minecraft_version=${resolved.minecraftVersion}`,
    `fabric_loader=${resolved.fabricLoaderVersion}`,
    `main_class=${resolved.fabricMainClass}`,
    `client_jar=${clientJar}`,
    `asset_index=${assetIndexPath}`,
    `logging_config=${loggingPath}`,
    `natives_dir=${nativesDir}`,
    `assets_root=${assetsDir}`,
    `classpath_entries=${classpath.length}`
  ].join('\n'));
}

const bundledMods = [
  ['Fabric-API', 'https://modrinth.com/mod/fabric-api', 0],
  ['Balm', 'https://modrinth.com/mod/balm', 0],
  ['Sodium', 'https://modrinth.com/mod/sodium', 0],
  ['Iris', 'https://modrinth.com/mod/iris', 0],
  ['Bookshelf', 'https://modrinth.com/mod/bookshelf-lib', 0],
  ['Default Options', 'https://modrinth.com/mod/default-options', 0],
  ['Fancy Menu', 'https://modrinth.com/mod/fancymenu', 0],
  ['Konkrete', 'https://modrinth.com/mod/konkrete', 0],
  ['MCEF', 'https://modrinth.com/mod/mcef-keksuccino', 0],
  ['Melody', 'https://modrinth.com/mod/melody', 0],
  ['Prickle', 'https://modrinth.com/mod/prickle', 0],
  ['Xaeros World Map', 'https://modrinth.com/mod/xaeros-world-map', 0],
  ['Auth Me', 'https://modrinth.com/mod/auth-me', 0],
  ['No Chat Restrictions', 'https://modrinth.com/mod/no-chat-restrictions', 0],
  ['Minescape Utility', 'https://modrinth.com/mod/minescapeutility', 0]
].map(([id, source, versionOffset]) => ({ id, fileName: '', source, required: true, versionOffset }));

function manifest() {
  const resolved = state.resolvedVersion;
  return {
    name: CONFIG.clientName,
    minecraftVersion: resolved?.minecraftVersion || CONFIG.minecraftVersion,
    fabricLoaderVersion: resolved?.fabricLoaderVersion || CONFIG.fabricLoaderSelection,
    mods: bundledMods
  };
}

async function loadSettings(inst = instanceDirectory()) {
  const settingsPath = path.join(inst, 'metadata', 'mod-settings.json');
  const defaults = {
    vanillaLaunch: false,
    enabledMods: Object.fromEntries(bundledMods.map(m => [m.id, true])),
    versionOffsets: Object.fromEntries(bundledMods.map(m => [m.id, m.versionOffset || 0])),
    prepareRequiredMods: {}
  };
  const saved = await readJson(settingsPath, {});
  return {
    ...defaults,
    ...saved,
    enabledMods: { ...defaults.enabledMods, ...(saved.enabledMods || {}) },
    versionOffsets: { ...defaults.versionOffsets, ...(saved.versionOffsets || {}) },
    prepareRequiredMods: { ...(saved.prepareRequiredMods || {}) }
  };
}

async function saveSettings(settings, inst = instanceDirectory()) {
  await mkdir(path.join(inst, 'metadata'));
  await fs.writeFile(path.join(inst, 'metadata', 'mod-settings.json'), JSON.stringify(settings, null, 2));
}

async function syncDefaults(inst) {
  const versionCheck = await checkDefaultResourceVersion(inst);
  const forceRemoteDownload = versionCheck.prepareRequired;
  status(`GitHub resources version: ${versionCheck.remoteVersion || 'missing'} | Local: ${versionCheck.localVersion || 'missing'} | Redownload: ${forceRemoteDownload}`);
  if (forceRemoteDownload) {
    status(`Default client resources changed from ${versionCheck.localVersion || 'none'} to ${versionCheck.remoteVersion}. Redownloading GitHub files...`);
  }
  const tree = await fetchJson('https://api.github.com/repos/MrZylr/Minescape-Addons-Client-Resources/git/trees/main?recursive=1', {
    headers: { 'User-Agent': CONFIG.userAgent }
  });
  for (const entry of tree.tree || []) {
    if (!entry.path) continue;
    if (entry.path === 'launcher_version') continue;
    const target = path.join(inst, ...entry.path.split('/'));
    if (entry.type === 'tree') await mkdir(target);
    if (entry.type === 'blob') {
      await download(githubDefaultsRawUrl(entry.path), target, {
        'User-Agent': CONFIG.userAgent,
        force: forceRemoteDownload
      });
    }
  }
  if (!(await exists(path.join(inst, 'xaero')))) throw new Error('Default content sync failed: missing xaero folder after GitHub sync.');
  state.defaultResources.prepareRequired = false;
  state.defaultResources.localVersion = state.defaultResources.remoteVersion;
}

async function checkDefaultResourceVersion(inst = instanceDirectory()) {
  const remoteVersion = await fetchGithubDefaultsVersion();
  const localVersion = (await readTextIfExists(path.join(inst, 'version'))).trim();
  const prepareRequired = Boolean(remoteVersion && localVersion !== remoteVersion);
  state.defaultResources = {
    checked: true,
    remoteVersion,
    localVersion,
    prepareRequired
  };
  return state.defaultResources;
}

async function fetchGithubDefaultsVersion() {
  try {
    const url = `${githubDefaultsRawUrl('version')}?t=${Date.now()}`;
    return (await fetchText(url, {
      headers: { 'User-Agent': CONFIG.userAgent, 'Cache-Control': 'no-cache' }
    })).trim();
  } catch {
    return '';
  }
}

async function checkLauncherVersion() {
  const remoteVersion = await fetchGithubTextFile('launcher_version');
  const localVersion = CONFIG.launcherVersion;
  return {
    remoteVersion,
    localVersion,
    updateRequired: Boolean(remoteVersion && localVersion !== remoteVersion)
  };
}

async function fetchGithubTextFile(remotePath) {
  try {
    return (await fetchText(`${githubDefaultsRawUrl(remotePath)}?t=${Date.now()}`, {
      headers: { 'User-Agent': CONFIG.userAgent, 'Cache-Control': 'no-cache' }
    })).trim();
  } catch {
    return '';
  }
}

function showLauncherUpdateWindow(versionCheck) {
  const updateWindow = new BrowserWindow({
    width: 460,
    height: 280,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: state.win,
    modal: true,
    title: 'Launcher Update Available',
    icon: assetPath('assets', 'logo', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  updateWindow.setMenuBarVisibility(false);
  updateWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  updateWindow.webContents.on('will-navigate', event => {
    event.preventDefault();
  });
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Launcher Update Available</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101417;
      color: #eff5fb;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    main {
      width: 100%;
      height: 100%;
      padding: 24px;
      border-top: 1px solid rgba(255, 255, 255, 0.15);
      background: linear-gradient(90deg, rgba(5, 8, 10, 0.94), rgba(20, 27, 31, 0.94));
    }
    h1 {
      margin: 0 0 10px;
      color: #67d29d;
      font-size: 22px;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 14px;
      color: #b7c1cb;
      line-height: 1.5;
      font-size: 14px;
    }
    a {
      color: #e4c45d;
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 22px;
    }
    button {
      min-width: 86px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 10px 16px;
      color: #07110b;
      background: #67d29d;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main>
    <h1>Launcher update available</h1>
    <p>Your launcher version is ${escapeHtml(versionCheck.localVersion || 'none')}. The latest version is ${escapeHtml(versionCheck.remoteVersion)}.</p>
    <p><a href="${LAUNCHER_UPDATE_URL}" target="_blank" rel="noreferrer">Open launcher update page</a></p>
    <div class="actions">
      <button onclick="window.close()">OK</button>
    </div>
  </main>
</body>
</html>`;
  updateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function readTextIfExists(target) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return '';
  }
}

function githubDefaultsRawUrl(remotePath) {
  return `https://raw.githubusercontent.com/MrZylr/Minescape-Addons-Client-Resources/main/${remotePath.split('/').map(encodeURIComponent).join('/')}`;
}

function modrinthProjectRef(source) {
  if (source.startsWith('modrinth:')) return source.slice('modrinth:'.length).trim();
  const url = new URL(source);
  const parts = url.pathname.split('/').filter(Boolean);
  return ['mod', 'plugin', 'modpack', 'resourcepack', 'shader'].includes(parts[0]) ? parts[1] : parts[0];
}

async function syncMods(inst) {
  const settings = await loadSettings(inst);
  const modsDir = path.join(inst, 'mods');
  const stateDir = path.join(inst, 'metadata', 'mod-state');
  await Promise.all([mkdir(modsDir), mkdir(stateDir)]);
  await fs.writeFile(path.join(inst, 'modpack.json'), JSON.stringify(manifest(), null, 2));
  let downloaded = 0, present = 0, unresolved = 0, disabled = 0;
  for (const mod of bundledMods) {
    if (settings.vanillaLaunch || settings.enabledMods[mod.id] === false) {
      disabled++;
      continue;
    }
    try {
      const file = await resolveModrinthFile(mod, settings.versionOffsets?.[mod.id]);
      if (!file?.url || !file?.filename) {
        unresolved++;
        continue;
      }
      const target = path.join(modsDir, file.filename);
      if (await exists(target)) present++;
      else {
        await download(file.url, target, { 'User-Agent': CONFIG.userAgent });
        downloaded++;
      }
      await cleanupReplacedManagedMod(mod.id, file.filename, stateDir, modsDir);
      await fs.writeFile(path.join(stateDir, `${mod.id}.txt`), `installedFile=${file.filename}`);
      settings.prepareRequiredMods = settings.prepareRequiredMods || {};
      delete settings.prepareRequiredMods[mod.id];
      await saveSettings(settings, inst);
    } catch {
      unresolved++;
    }
  }
  return `Modpack sync complete. Downloaded ${downloaded}, present ${present}, unresolved ${unresolved}, disabled ${disabled}.`;
}

async function resolveModrinthFile(mod, configuredOffset) {
  const versions = await fetchJson(`https://api.modrinth.com/v2/project/${modrinthProjectRef(mod.source)}/version`, {
    headers: { 'User-Agent': CONFIG.userAgent }
  });
  const compatible = versions
    .filter(v => (v.status || 'listed') === 'listed' && v.game_versions?.includes(CONFIG.minecraftVersion) && v.loaders?.includes('fabric'))
    .sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  const normalizedOffset = normalizeVersionOffset(configuredOffset ?? mod.versionOffset ?? 0);
  const selected = ['release', 'beta', 'alpha']
    .flatMap(type => compatible.filter(v => v.version_type === type))[normalizedOffset] || compatible[0];
  const file = selected?.files?.find(f => f.primary) || selected?.files?.[0];
  if (!file) return null;
  return {
    filename: file.filename,
    url: file.url,
    versionNumber: selected.version_number,
    versionType: selected.version_type,
    datePublished: selected.date_published,
    offset: normalizedOffset
  };
}

function normalizeVersionOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

async function cleanupReplacedManagedMod(modId, currentFileName, stateDir, modsDir) {
  const previousFileName = await installedFileForStateDir(modId, stateDir);
  if (!previousFileName || previousFileName === currentFileName) return;
  await fs.rm(path.join(modsDir, previousFileName), { force: true }).catch(() => {});
  await fs.rm(path.join(modsDir, `${previousFileName}.disabled`), { force: true }).catch(() => {});
}

async function checkModVersion(modId, offset) {
  const mod = bundledMods.find(entry => entry.id === modId);
  if (!mod) throw new Error(`Unknown mod: ${modId}`);
  const target = await resolveModrinthFile(mod, offset);
  const installedFile = await installedFileFor(modId);
  const installedExists = installedFile
    ? await exists(path.join(instanceDirectory(), 'mods', installedFile))
    : false;
  const prepareRequired = Boolean(target?.filename && installedFile && installedFile !== target.filename)
    || Boolean(target?.filename && (!installedFile || !installedExists));
  const settings = await loadSettings();
  settings.prepareRequiredMods = settings.prepareRequiredMods || {};
  if (prepareRequired) {
    settings.prepareRequiredMods[modId] = {
      installedFile,
      targetFile: target?.filename || '',
      offset: target?.offset ?? normalizeVersionOffset(offset),
      checkedAt: new Date().toISOString()
    };
  } else {
    delete settings.prepareRequiredMods[modId];
  }
  await saveSettings(settings);
  return {
    modId,
    installedFile,
    installedExists,
    targetFile: target?.filename || '',
    targetVersion: target?.versionNumber || '',
    offset: target?.offset ?? normalizeVersionOffset(offset),
    prepareRequired
  };
}

async function listFiles(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function disableJar(file) {
  if (!file.toLowerCase().endsWith('.jar') || !(await exists(file))) return;
  await fs.rename(file, `${file}.disabled`).catch(() => {});
}

async function restoreJar(file) {
  const disabled = `${file}.disabled`;
  if (!(await exists(file)) && (await exists(disabled))) {
    await fs.rename(disabled, file).catch(() => {});
  }
}

async function installedFileFor(modId, inst = instanceDirectory()) {
  try {
    return await installedFileForStateDir(modId, path.join(inst, 'metadata', 'mod-state'));
  } catch {
    return '';
  }
}

async function installedFileForStateDir(modId, stateDir) {
  try {
    const text = await fs.readFile(path.join(stateDir, `${modId}.txt`), 'utf8');
    return text.split(/\r?\n/).find(line => line.startsWith('installedFile='))?.slice('installedFile='.length).trim() || '';
  } catch {
    return '';
  }
}

async function applyConfiguredModState(inst = instanceDirectory()) {
  const settings = await loadSettings(inst);
  const modsDir = path.join(inst, 'mods');
  await mkdir(modsDir);
  const files = await listFiles(modsDir);
  if (settings.vanillaLaunch) {
    for (const entry of files) {
      if (entry.isFile()) await disableJar(path.join(modsDir, entry.name));
    }
    return;
  }
  for (const entry of files) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar.disabled')) {
      const restored = path.join(modsDir, entry.name.slice(0, -'.disabled'.length));
      if (!(await exists(restored))) await fs.rename(path.join(modsDir, entry.name), restored).catch(() => {});
    }
  }
  for (const mod of bundledMods) {
    const installed = await installedFileFor(mod.id, inst);
    if (!installed) continue;
    const modFile = path.join(modsDir, installed);
    if (settings.enabledMods[mod.id] === false) await disableJar(modFile);
    else await restoreJar(modFile);
  }
}

async function modsReadyForLaunch(inst = instanceDirectory()) {
  const settings = await loadSettings(inst);
  if (settings.vanillaLaunch) return true;
  const modsDir = path.join(inst, 'mods');
  for (const mod of bundledMods) {
    if (!mod.required || settings.enabledMods[mod.id] === false) continue;
    const installed = await installedFileFor(mod.id, inst);
    if (!installed) return false;
    const modFile = path.join(modsDir, installed);
    if (!(await exists(modFile)) || (await exists(`${modFile}.disabled`))) return false;
  }
  return true;
}

async function prepareClient() {
  if (!CONFIG.offlineDevLaunchEnabled && state.sessions.length === 0) {
    return { ok: false, message: 'Sign in before preparing the client.' };
  }
  state.prepareInProgress = true;
  const inst = instanceDirectory();
  try {
    send('prepare-progress', 5);
    status(`Preparing client for instance ${path.basename(inst)}. Resolving version metadata...`);
    await resolveVersion();
    send('prepare-progress', 20);
    status('Preparing client. Creating local directories...');
    await Promise.all([mkdir(roots.working), mkdir(roots.instances), mkdir(inst), mkdir(path.join(inst, 'mods')), mkdir(path.join(inst, 'metadata')), mkdir(roots.runtime), mkdir(roots.metadata)]);
    send('prepare-progress', 42);
    status('Preparing client. Downloading runtime artifacts...');
    await prepareRuntime();
    send('prepare-progress', 76);
    status('Preparing client. Syncing default client content...');
    await syncDefaults(inst);
    send('prepare-progress', 88);
    status('Preparing client. Syncing managed mods...');
    const modReport = await syncMods(inst);
    await applyConfiguredModState(inst);
    send('prepare-progress', 96);
    await fs.writeFile(path.join(inst, 'client-profile.txt'), [
      `client=${CONFIG.clientName}`,
      `minecraft=${CONFIG.minecraftVersion}`,
      `fabric=${state.resolvedVersion?.fabricLoaderVersion || CONFIG.fabricLoaderSelection}`,
      `created=${new Date().toISOString()}`
    ].join('\n'));
    send('prepare-progress', 100);
    return { ok: true, message: `Prepare Client finished. ${modReport}` };
  } finally {
    state.prepareInProgress = false;
  }
}

function buildOfflineSession() {
  const username = CONFIG.offlineDevUsername || 'DevPlayer';
  return {
    username,
    microsoftAccessToken: '',
    microsoftRefreshToken: '',
    minecraftAccessToken: 'offline-dev-token',
    minecraftUuid: crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    expiresAt: null
  };
}

async function refreshMicrosoftSession(session) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CONFIG.microsoftClientId,
    refresh_token: session.microsoftRefreshToken,
    scope: CONFIG.microsoftScope
  });
  const token = await fetchJson(`https://login.microsoftonline.com/${CONFIG.microsoftTenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return { ...session, microsoftAccessToken: token.access_token, microsoftRefreshToken: token.refresh_token || session.microsoftRefreshToken, expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() };
}

async function resolveMinecraftSession(ms) {
  const xbox = await fetchJson('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${ms.microsoftAccessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' })
  });
  const xsts = await fetchJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' })
  });
  const mcAuth = await fetchJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${xsts.DisplayClaims.xui[0].uhs};${xsts.Token}` })
  });
  const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcAuth.access_token}`, Accept: 'application/json' }
  });
  return { username: profile.name, microsoftAccessToken: ms.microsoftAccessToken, microsoftRefreshToken: ms.microsoftRefreshToken, minecraftAccessToken: mcAuth.access_token, minecraftUuid: profile.id, expiresAt: ms.expiresAt };
}

async function prepareLaunchSession() {
  let session = activeSession();
  if (session?.minecraftAccessToken) return session;
  if (session?.microsoftRefreshToken) {
    session = await refreshMicrosoftSession(session);
    session = await resolveMinecraftSession(session);
    await upsertSession(session);
    return session;
  }
  if (CONFIG.offlineDevLaunchEnabled) return buildOfflineSession();
  throw new Error('Complete Microsoft sign-in and Minecraft session resolution first.');
}

async function readiness() {
  const version = CONFIG.minecraftVersion;
  const inst = instanceDirectory();
  const checks = [
    [path.join(roots.metadata, 'resolved-version.txt'), 'missing resolved version metadata'],
    [path.join(roots.metadata, `runtime-${version}.txt`), `missing runtime manifest for Minecraft ${version}`],
    [path.join(roots.metadata, `classpath-${version}.txt`), `missing classpath manifest for Minecraft ${version}`],
    [path.join(inst, 'client-profile.txt'), 'missing client profile manifest'],
    [path.join(inst, 'modpack.json'), 'missing modpack snapshot'],
    [path.join(roots.runtime, 'versions', version, `${version}.jar`), `missing client jar for Minecraft ${version}`]
  ];
  for (const [file, reason] of checks) if (!(await exists(file))) return { ready: false, reason };
  if (!(await exists(path.join(inst, 'config')))) return { ready: false, reason: 'missing config directory' };
  if (!(await exists(path.join(inst, 'XaeroWorldMap'))) && !(await exists(path.join(inst, 'xaero')))) return { ready: false, reason: 'missing root xaero map data directory' };
  const settings = await loadSettings(inst);
  const requiredMods = Object.keys(settings.prepareRequiredMods || {});
  if (requiredMods.length > 0) return { ready: false, reason: `Prepare Client required for ${requiredMods.join(', ')}` };
  if (state.defaultResources.prepareRequired) {
    return {
      ready: false,
      reason: configUpdateRequiredMessage()
    };
  }
  if (!(await modsReadyForLaunch(inst))) return { ready: false, reason: 'required managed mods are missing or unresolved' };
  if (await isRunning(inst)) return { ready: false, reason: 'this account already has an active client open' };
  return { ready: true, reason: 'ready' };
}

async function runtimeValue(key) {
  const file = path.join(roots.metadata, `runtime-${CONFIG.minecraftVersion}.txt`);
  const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
  const prefix = `${key}=`;
  return lines.find(line => line.startsWith(prefix))?.slice(prefix.length) || '';
}

function collectArgs(values, variables) {
  const out = [];
  for (const value of values || []) {
    if (typeof value === 'string') out.push(replaceVars(value, variables));
    else if (!value.rules || allowedArg(value.rules)) {
      const raw = value.value;
      if (typeof raw === 'string') out.push(replaceVars(raw, variables));
      else if (Array.isArray(raw)) out.push(...raw.filter(v => typeof v === 'string').map(v => replaceVars(v, variables)));
    }
  }
  return out;
}

function normalizeJvmArgs(args) {
  const normalized = [];
  let gcSelected = false;
  for (const arg of args) {
    if (isGarbageCollectorArg(arg)) {
      if (gcSelected) continue;
      gcSelected = true;
    }
    normalized.push(arg);
  }
  return normalized;
}

function isGarbageCollectorArg(arg) {
  return arg.includes('UseZGC')
    || arg.includes('UseG1GC')
    || arg.includes('UseShenandoahGC')
    || arg.includes('UseParallelGC')
    || arg.includes('UseSerialGC');
}

function allowedArg(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.features) continue;
    if (rule.os?.name && rule.os.name !== 'windows') continue;
    allowed = rule.action === 'allow' ? true : rule.action === 'disallow' ? false : allowed;
  }
  return allowed;
}

function replaceVars(text, vars) {
  return text.replace(/\$\{([^}]+)}/g, (_, key) => vars[key] ?? '');
}

async function launchMinecraft() {
  const ready = await readiness();
  if (!ready.ready) throw new Error(`Launch blocked: ${ready.reason}`);
  const inst = instanceDirectory();
  await applyConfiguredModState(inst);
  const session = await prepareLaunchSession();
  const versionRoot = await readJson(path.join(roots.metadata, `${CONFIG.minecraftVersion}.json`), {});
  const resolved = await readResolvedVersion();
  const fabricRoot = await readJson(path.join(roots.metadata, `fabric-${resolved.fabricLoaderVersion}-${CONFIG.minecraftVersion}.json`), {});
  const classpath = (await fs.readFile(path.join(roots.metadata, `classpath-${CONFIG.minecraftVersion}.txt`), 'utf8')).split(/\r?\n/).filter(Boolean);
  const clientIdPath = path.join(roots.metadata, 'client-id.txt');
  const clientId = await exists(clientIdPath) ? (await fs.readFile(clientIdPath, 'utf8')).trim() : crypto.randomUUID();
  if (!(await exists(clientIdPath))) await fs.writeFile(clientIdPath, clientId);
  const vars = {
    auth_player_name: session.username,
    version_name: `fabric-loader-${resolved.fabricLoaderVersion}-${CONFIG.minecraftVersion}`,
    game_directory: inst,
    assets_root: await runtimeValue('assets_root'),
    assets_index_name: versionRoot.assetIndex?.id || '',
    auth_uuid: session.minecraftUuid,
    auth_access_token: session.minecraftAccessToken,
    clientid: clientId,
    auth_xuid: '',
    version_type: versionRoot.type || '',
    natives_directory: await runtimeValue('natives_dir'),
    launcher_name: CONFIG.clientName,
    launcher_version: CONFIG.minecraftVersion,
    classpath: classpath.join(';'),
    classpath_separator: ';',
    resolution_width: '1280',
    resolution_height: '720',
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
    log4j_path: await runtimeValue('logging_config')
  };
  const jvmArgs = normalizeJvmArgs([
    ...collectArgs(versionRoot.arguments?.['default-user-jvm'], vars),
    ...collectArgs(versionRoot.arguments?.jvm, vars),
    ...collectArgs(fabricRoot.jvm, vars)
  ]);
  const gameArgs = [...collectArgs(versionRoot.arguments?.game, vars), ...collectArgs(fabricRoot.game, vars)];
  const java = path.join(process.env.JAVA_HOME || '', 'bin', 'java.exe');
  const javaExe = fss.existsSync(java) ? java : 'java';
  const mainClass = fabricRoot.mainClass || versionRoot.mainClass;
  await mkdir(path.join(inst, 'logs'));
  await mkdir(path.join(inst, 'metadata'));
  const log = fss.openSync(path.join(inst, 'logs', 'latest-client.log'), 'a');
  const child = spawn(javaExe, [...jvmArgs, mainClass, ...gameArgs], { cwd: inst, stdio: ['ignore', log, log], windowsHide: false, detached: true });
  await fs.writeFile(path.join(inst, 'metadata', 'active-client.pid'), String(child.pid));
  child.once('error', async error => {
    await fs.rm(path.join(inst, 'metadata', 'active-client.pid'), { force: true });
    status(`Minecraft process start failed: ${error.message}`);
  });
  child.once('exit', async code => {
    await fs.rm(path.join(inst, 'metadata', 'active-client.pid'), { force: true });
    if (code !== 0) {
      status(`Minecraft exited with code ${code}. Check ${path.join(inst, 'logs', 'latest-client.log')}.`);
    } else {
      status('Minecraft client closed.');
    }
    send('accounts', await publicState());
  });
  child.unref();
  return `Minecraft launch started. Output is being written to ${path.join(inst, 'logs', 'latest-client.log')}.`;
}

async function isRunning(inst) {
  const pidFile = path.join(inst, 'metadata', 'active-client.pid');
  try {
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    if (!pid) {
      await fs.rm(pidFile, { force: true });
      return false;
    }
    if (process.platform === 'win32') {
      const running = isWindowsMinecraftProcess(pid, inst);
      if (!running) await fs.rm(pidFile, { force: true });
      return running;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      await fs.rm(pidFile, { force: true });
      return false;
    }
  } catch {
    return false;
  }
}

function isWindowsMinecraftProcess(pid, inst) {
  const query = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`
  ], { encoding: 'utf8', windowsHide: true });
  const commandLine = (query.stdout || '').trim().toLowerCase();
  if (!commandLine) return false;
  const normalizedInstance = inst.toLowerCase();
  return commandLine.includes('java')
    && commandLine.includes('net.fabricmc.loader.impl.launch.knot.knotclient')
    && commandLine.includes(normalizedInstance);
}

async function beginLogin() {
  if (!CONFIG.minecraftAuthApproved) throw new Error('Minecraft account launch is blocked until this app registration is approved.');
  const stateToken = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer();
  const done = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://localhost:${server.address().port}`);
      if (url.searchParams.get('state') !== stateToken) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(false));
        reject(new Error('State validation failed.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(true));
      resolve(url.searchParams.get('code'));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirect = `http://localhost:${server.address().port}`;
  const authUrl = `https://login.microsoftonline.com/${CONFIG.microsoftTenant}/oauth2/v2.0/authorize?${new URLSearchParams({
    client_id: CONFIG.microsoftClientId,
    response_type: 'code',
    redirect_uri: redirect,
    response_mode: 'query',
    scope: CONFIG.microsoftScope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: stateToken
  })}`;
  state.login = { server, done, redirect, verifier };
  await shell.openExternal(authUrl);
  done.then(async code => {
    server.close();
    const token = await fetchJson(`https://login.microsoftonline.com/${CONFIG.microsoftTenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CONFIG.microsoftClientId, code, redirect_uri: redirect, code_verifier: verifier, scope: CONFIG.microsoftScope })
    });
    const resolved = await resolveMinecraftSession({
      username: 'Microsoft account authenticated',
      microsoftAccessToken: token.access_token,
      microsoftRefreshToken: token.refresh_token,
      minecraftAccessToken: '',
      minecraftUuid: '',
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString()
    });
    await upsertSession(resolved);
    await checkDefaultResourceVersion(instanceDirectory());
    send('accounts', await publicState());
    status(`Minecraft profile resolved for ${resolved.username}.`);
  }).catch(err => status(`Microsoft sign-in failed: ${err.message}`));
  return { ok: true, url: authUrl, message: 'Microsoft sign-in opened in your browser.' };
}

function callbackPage(success) {
  const title = success ? 'Sign-in complete' : 'Sign-in failed';
  const message = success
    ? 'You can close this window and return to MineScape Addons.'
    : 'Microsoft sign-in could not be completed. Return to the launcher and try again.';
  const accent = success ? '#67d29d' : '#ff796d';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101417;
      color: #eff5fb;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(5, 8, 10, 0.92), rgba(5, 8, 10, 0.58)),
        radial-gradient(circle at 70% 20%, rgba(103, 210, 157, 0.16), transparent 34%);
    }
    .panel {
      position: relative;
      width: min(440px, calc(100vw - 32px));
      padding: 24px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      background: rgba(14, 18, 22, 0.92);
      box-shadow: 0 18px 52px rgba(0, 0, 0, 0.35);
    }
    h1 {
      margin: 0 0 10px;
      color: ${accent};
      font-size: 24px;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: #b7c1cb;
      line-height: 1.5;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <main class="panel">
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`;
}

async function fetchBlog() {
  try {
    const html = await fetchText('https://minescape.com/blog/', { headers: { 'User-Agent': CONFIG.userAgent } });
    const posts = [...html.matchAll(/<li><a href="([^"]+)">([^<]+)<\/a><\/li>/g)].slice(0, 6).map(match => ({
      url: new URL(match[1], 'https://minescape.com').toString(),
      title: match[2].replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"'),
      imageUrl: ''
    }));
    return Promise.all(posts.map(async post => ({
      ...post,
      imageUrl: await resolveBlogImage(post.url)
    })));
  } catch {
    return [];
  }
}

async function resolveBlogImage(url) {
  try {
    const html = await fetchText(url.endsWith('/') ? url : `${url}/`, { headers: { 'User-Agent': CONFIG.userAgent } });
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1];
    if (ogImage) return new URL(ogImage, 'https://minescape.com').toString();
    for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
      const imageUrl = new URL(match[1], 'https://minescape.com').toString();
      if (!imageUrl.toLowerCase().includes('logo')) return imageUrl;
    }
  } catch {}
  return '';
}

async function publicState() {
  await readResolvedVersion();
  const ready = await readiness();
  const canLaunch = ready.ready && (CONFIG.offlineDevLaunchEnabled || state.sessions.length > 0);
  const canPrepare = CONFIG.offlineDevLaunchEnabled || state.sessions.length > 0;
  const displayReady = !canPrepare
    ? { ready: false, reason: 'Sign in to a Minecraft account' }
    : isFirstRunPrepareReason(ready.reason)
    ? { ready: false, reason: 'Prepare Client required' }
    : ready.reason === 'this account already has an active client open'
    ? { ready: false, reason: 'Client is running' }
    : ready;
  return {
    title: CONFIG.clientName,
    versionText: `Minecraft ${state.resolvedVersion?.minecraftVersion || CONFIG.minecraftVersion} / Fabric ${state.resolvedVersion?.fabricLoaderVersion || CONFIG.fabricLoaderSelection}`,
    accounts: state.sessions.map(s => s.username),
    selectedAccount: state.activeUsername || 'No cached accounts',
    fabricStatus: state.resolvedVersion ? 'Confirmed' : 'Pending verification',
    ready: displayReady,
    canLaunch,
    canPrepare,
    settings: await loadSettings(),
    mods: bundledMods
  };
}

function createWindow() {
  state.win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    icon: assetPath('assets', 'logo', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(buildApplicationMenu());
  state.win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function buildApplicationMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Directory',
          click: async () => {
            const inst = instanceDirectory();
            await mkdir(inst);
            await shell.openPath(inst);
          }
        },
        { type: 'separator' },
        { role: 'close' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Update',
          click: async () => {
            const result = await checkLauncherVersion();
            if (result.updateRequired) {
              showLauncherUpdateWindow(result);
              return;
            }
            showInfoWindow(
              'Launcher is up to date',
              `You are running launcher version ${result.localVersion || CONFIG.launcherVersion}.`
            );
          }
        },
        {
          label: 'Update Launcher',
          click: async () => {
            await shell.openExternal('https://github.com/MrZylr/Minescape-Addons-Launcher');
          }
        }
      ]
    }
  ]);
}

function showInfoWindow(title, message) {
  const infoWindow = new BrowserWindow({
    width: 420,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: state.win,
    modal: true,
    title,
    icon: assetPath('assets', 'logo', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  infoWindow.setMenuBarVisibility(false);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101417;
      color: #eff5fb;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    main {
      width: 100%;
      height: 100%;
      padding: 24px;
      background: linear-gradient(90deg, rgba(5, 8, 10, 0.94), rgba(20, 27, 31, 0.94));
    }
    h1 {
      margin: 0 0 10px;
      color: #67d29d;
      font-size: 22px;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: #b7c1cb;
      line-height: 1.5;
      font-size: 14px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 28px;
    }
    button {
      min-width: 86px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 10px 16px;
      color: #07110b;
      background: #67d29d;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="actions">
      <button onclick="window.close()">OK</button>
    </div>
  </main>
</body>
</html>`;
  infoWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

ipcMain.handle('app:state', publicState);
ipcMain.handle('app:blog', fetchBlog);
ipcMain.handle('auth:login', beginLogin);
ipcMain.handle('auth:logout', async () => {
  state.sessions = state.sessions.filter(s => s.username !== state.activeUsername);
  state.activeUsername = state.sessions[0]?.username || '';
  await saveSessions();
  await checkDefaultResourceVersion(instanceDirectory());
  return publicState();
});
ipcMain.handle('accounts:select', async (_event, username) => {
  if (state.sessions.some(s => s.username === username)) state.activeUsername = username;
  await saveSessions();
  await checkDefaultResourceVersion(instanceDirectory());
  return publicState();
});
ipcMain.handle('prepare:start', async () => {
  try {
    const result = await prepareClient();
    status(result.ok ? result.message : `Prepare Client failed: ${result.message}`);
    return result;
  } catch (err) {
    status(`Prepare Client failed: ${err.message}`);
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('mods:settings', async (_event, settings) => {
  await saveSettings(settings);
  await applyConfiguredModState();
  return publicState();
});
ipcMain.handle('mods:check-version', async (_event, modId, offset) => checkModVersion(modId, offset));
ipcMain.handle('launch:start', async () => {
  try {
    const message = await launchMinecraft();
    status(message);
    return { ok: true, message };
  } catch (err) {
    status(err.message);
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('shell:open', (_event, url) => shell.openExternal(url));

app.whenReady().then(async () => {
  await loadSessions();
  createWindow();
  checkLauncherVersion()
    .then(result => {
      if (result.updateRequired) showLauncherUpdateWindow(result);
    })
    .catch(() => {});
  checkDefaultResourceVersion()
    .then(async result => {
      if (result.prepareRequired) {
        status(configUpdateRequiredMessage());
      }
      send('accounts', await publicState());
    })
    .catch(error => status(`GitHub resource version check failed: ${error.message}`));
});

function configUpdateRequiredMessage() {
  return `Prepare client needed to update config data. ${state.defaultResources.localVersion || 'none'} -> ${state.defaultResources.remoteVersion || 'unknown'}`;
}

function isFirstRunPrepareReason(reason) {
  return [
    'missing resolved version metadata',
    `missing runtime manifest for Minecraft ${CONFIG.minecraftVersion}`,
    `missing classpath manifest for Minecraft ${CONFIG.minecraftVersion}`,
    'missing client profile manifest',
    'missing modpack snapshot',
    `missing client jar for Minecraft ${CONFIG.minecraftVersion}`,
    'missing config directory',
    'missing root xaero map data directory',
    'required managed mods are missing or unresolved'
  ].includes(reason);
}
app.on('window-all-closed', () => {
  state.login?.server?.close();
  if (process.platform !== 'darwin') app.quit();
});
