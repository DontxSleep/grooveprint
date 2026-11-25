const {app, BrowserWindow, Menu} = require('electron');
const {existsSync, readFileSync, writeFileSync} = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const documentPath = path.join(__dirname, 'Grooveprint.html');
const documentURL = pathToFileURL(documentPath).href;
const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const reportPath = argument('--self-test');
const fixturePath = reportPath && argument('--fixture');
let window;

if (reportPath) {
  if (!fixturePath || !existsSync(fixturePath)) {
    console.error('Self-test needs a local audio fixture.');
    process.exit(1);
  }
  app.setPath('userData', path.join(path.dirname(reportPath), 'electron-test-profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fixturePath);
}

async function openWindow() {
  window = new BrowserWindow({
    width: 1150,
    height: 900,
    minWidth: 365,
    minHeight: 500,
    title: 'Grooveprint',
    backgroundColor: '#080d19',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !reportPath,
    },
  });
  if (process.platform === 'win32') app.setAppUserModelId('com.grooveprint.desktop');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {role: 'fileMenu'},
    {role: 'editMenu'},
  ]));

  const contents = window.webContents;
  const trusted = (requester, details) =>
    requester === contents && contents.getURL() === documentURL && details?.isMainFrame !== false &&
    (!details?.requestingUrl || details.requestingUrl === documentURL);
  contents.setWindowOpenHandler(() => ({action: 'deny'}));
  contents.on('will-navigate', (event, url) => {
    if (url !== documentURL) event.preventDefault();
  });
  const session = contents.session;
  session.setPermissionCheckHandler((requester, permission, _origin, details) =>
    permission === 'media' && details?.mediaType === 'audio' && trusted(requester, details));
  session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(permission === 'media' && trusted(requester, details) &&
      details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
  });
  session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_details, callback) => {
    callback({cancel: true});
  });
  session.on('will-download', (_event, item, requester) => {
    if (requester !== contents) {
      item.cancel();
      return;
    }
    if (reportPath) item.setSavePath(reportPath + '.mid');
    else item.setSaveDialogOptions({title: 'Save MIDI Clip', filters: [{name: 'MIDI', extensions: ['mid']}]});
  });

  if (!reportPath) window.once('ready-to-show', () => window.show());
  await window.loadFile(documentPath);
  if (reportPath) await selfTest(contents);
}

async function selfTest(contents) {
  const take = await contents.executeJavaScript(`(async () => {
    const get = id => document.getElementById(id);
    const until = async (condition, description) => {
      const deadline = Date.now() + 8000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(description + ': ' + get('status').textContent);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    };
    await until(() => get('take-meta').textContent.includes('Demo phrase · 8 notes'), 'Demo');
    if (get('appearance-skin').options.length !== 9 || get('appearance-background').options.length !== 9)
      throw new Error('Appearance options missing');
    get('appearance-open').click();
    if (!get('appearance').open) throw new Error('Picker did not open');
    for (const [id, value] of [['skin', 'gold'], ['background', 'aurora']]) {
      const select = get('appearance-' + id);
      select.value = value;
      select.dispatchEvent(new Event('change'));
      if (document.documentElement.dataset[id] !== value) throw new Error('Appearance did not apply');
    }
    get('appearance-close').click();
    get('record').click();
    await until(() => get('record-label').textContent === 'Stop recording', 'Mic start');
    await new Promise(resolve => setTimeout(resolve, 2850));
    get('record').click();
    await until(() => get('take-meta').textContent.includes('Microphone take · 5 notes'), 'Mic conversion');
    return get('take-meta').textContent;
  })()`, true);
  const download = new Promise((resolve, reject) => {
    contents.session.once('will-download', (_event, item) => {
      item.once('done', (_done, state) => state === 'completed' ? resolve() : reject(new Error(state)));
    });
  });
  await contents.executeJavaScript('document.getElementById("export").click()', true);
  await download;
  const midi = readFileSync(reportPath + '.mid');
  if (midi.subarray(0, 4).toString() !== 'MThd' || midi.length < 70) throw new Error('Invalid MIDI export');
  writeFileSync(reportPath, JSON.stringify({ok: true, platform: process.platform, take, skins: 9, backgrounds: 9}));
  app.exit(0);
}

app.whenReady().then(openWindow).catch(error => {
  console.error(error);
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ok: false, error: error.message}));
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
