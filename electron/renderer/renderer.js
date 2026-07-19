const els = {
  title: document.querySelector('#title'),
  version: document.querySelector('#version'),
  accounts: document.querySelector('#accounts'),
  login: document.querySelector('#login'),
  logout: document.querySelector('#logout'),
  prepare: document.querySelector('#prepare'),
  launch: document.querySelector('#launch'),
  progress: document.querySelector('#progress'),
  fabric: document.querySelector('#fabric'),
  ready: document.querySelector('#ready'),
  status: document.querySelector('#status'),
  vanilla: document.querySelector('#vanilla'),
  mods: document.querySelector('#mods'),
  blog: document.querySelector('#blog')
};

let current = null;
let launchInProgress = false;

function setStatus(message) {
  els.status.textContent = message || 'Ready.';
}

async function refresh() {
  current = await window.launcher.state();
  els.title.textContent = current.title;
  els.version.textContent = current.versionText;
  els.fabric.textContent = current.fabricStatus;
  els.ready.textContent = launchInProgress
    ? 'Launching client'
    : current.ready.ready
      ? (current.canLaunch ? 'Ready to launch' : 'Sign in required')
      : current.ready.reason;
  els.launch.disabled = !current.canLaunch;
  els.prepare.disabled = !current.canPrepare;

  els.accounts.innerHTML = '';
  const names = current.accounts.length ? current.accounts : ['No cached accounts'];
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    option.selected = name === current.selectedAccount;
    els.accounts.append(option);
  }

  els.vanilla.checked = Boolean(current.settings.vanillaLaunch);
  els.mods.innerHTML = '';
  for (const mod of current.mods) {
    const row = document.createElement('label');
    row.className = 'mod-row';
    const label = document.createElement('span');
    label.textContent = mod.id.replaceAll('_', ' ');
    const controls = document.createElement('div');
    controls.className = 'mod-controls';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'stepper';
    minus.textContent = '-';
    minus.title = 'Number of versions behind most up-to-date';

    const offset = document.createElement('input');
    offset.type = 'number';
    offset.min = '0';
    offset.step = '1';
    offset.value = current.settings.versionOffsets?.[mod.id] ?? mod.versionOffset ?? 0;
    offset.title = 'Number of versions behind most up-to-date';

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'stepper';
    plus.textContent = '+';
    plus.title = 'Number of versions behind most up-to-date';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = current.settings.enabledMods[mod.id] !== false;
    input.disabled = els.vanilla.checked;
    input.addEventListener('change', () => saveModSetting(mod.id, input.checked));
    minus.addEventListener('click', event => {
      event.preventDefault();
      saveVersionOffset(mod.id, Number(offset.value) - 1);
    });
    plus.addEventListener('click', event => {
      event.preventDefault();
      saveVersionOffset(mod.id, Number(offset.value) + 1);
    });
    offset.addEventListener('change', () => saveVersionOffset(mod.id, Number(offset.value)));
    controls.append(minus, offset, plus, input);
    row.append(label, controls);
    els.mods.append(row);
  }
}

async function saveModSetting(id, enabled) {
  current.settings.enabledMods[id] = enabled;
  await window.launcher.saveSettings(current.settings);
  setStatus(`Mod ${id} ${enabled ? 'enabled' : 'disabled'}.`);
  await refresh();
}

async function saveVersionOffset(id, value) {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  current.settings.versionOffsets = current.settings.versionOffsets || {};
  current.settings.versionOffsets[id] = normalized;
  await window.launcher.saveSettings(current.settings);
  setStatus(`Checking ${id} version offset against Modrinth...`);
  try {
    const check = await window.launcher.checkModVersion(id, normalized);
    if (check.prepareRequired) {
      setStatus(`${id} offset ${normalized} points to ${check.targetFile}. Installed: ${check.installedFile || 'none'}. Prepare Client is required.`);
    } else {
      setStatus(`${id} offset ${normalized} already matches ${check.targetFile || 'the current resolved file'}.`);
    }
  } catch (error) {
    setStatus(`${id} offset saved, but Modrinth check failed: ${error.message}. Prepare Client will verify it.`);
  }
  await refresh();
}

async function loadBlog() {
  const posts = await window.launcher.blog();
  els.blog.innerHTML = '';
  if (!posts.length) {
    const empty = document.createElement('div');
    empty.className = 'blog-empty';
    empty.textContent = 'No posts loaded.';
    els.blog.append(empty);
    return;
  }
  for (const post of posts) {
    const link = document.createElement('a');
    link.href = post.url;
    link.title = post.title;
    if (post.imageUrl) {
      const image = document.createElement('img');
      image.src = post.imageUrl;
      image.alt = post.title;
      link.append(image);
    } else {
      link.textContent = post.title;
    }
    link.addEventListener('click', event => {
      event.preventDefault();
      window.launcher.openExternal(post.url);
    });
    els.blog.append(link);
  }
}

els.login.addEventListener('click', async () => {
  const result = await window.launcher.login();
  setStatus(result.message);
});

els.logout.addEventListener('click', async () => {
  await window.launcher.logout();
  setStatus('Signed out.');
  await refresh();
});

els.accounts.addEventListener('change', async () => {
  await window.launcher.selectAccount(els.accounts.value);
  setStatus(`Selected cached account: ${els.accounts.value}.`);
  await refresh();
});

els.prepare.addEventListener('click', async () => {
  if (!current?.canPrepare) {
    setStatus('Sign in before preparing the client.');
    return;
  }
  els.prepare.disabled = true;
  els.progress.value = 5;
  const result = await window.launcher.prepare();
  setStatus(result.ok ? result.message : `Prepare Client failed: ${result.message}`);
  await refresh();
});

els.launch.addEventListener('click', async () => {
  launchInProgress = true;
  els.launch.disabled = true;
  els.ready.textContent = 'Launching client';
  setStatus('Launching Minecraft client...');
  const result = await window.launcher.launch();
  setStatus(result.message);
  launchInProgress = false;
  els.launch.disabled = !current?.canLaunch;
  await refresh();
});

els.vanilla.addEventListener('change', async () => {
  current.settings.vanillaLaunch = els.vanilla.checked;
  await window.launcher.saveSettings(current.settings);
  setStatus(`Vanilla launch ${els.vanilla.checked ? 'enabled' : 'disabled'}.`);
  await refresh();
});

window.launcher.onStatus(setStatus);
window.launcher.onProgress(value => {
  els.progress.value = value;
});
window.launcher.onAccounts(async value => {
  current = value;
  await refresh();
});

refresh().then(loadBlog).catch(error => setStatus(error.message));
