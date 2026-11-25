const appearanceOptions = {
  skin: [
    ['midnight', 'Midnight'], ['acid', 'Acid Green'], ['violet', 'Ultraviolet'],
    ['rose', 'Hot Pink'], ['ember', 'Ember'], ['ice', 'Glacier'],
    ['gold', 'Gold Circuit'], ['aqua', 'Sea Glass'], ['slate', 'Slate'],
  ],
  background: [
    ['city', 'Neon City'], ['grid', 'Laser Grid'], ['aurora', 'Aurora'],
    ['sunset', 'Afterglow'], ['signal', 'Radio Waves'], ['stars', 'Deep Space'],
    ['studio', 'Studio Mesh'], ['rain', 'Cyber Rain'], ['solid', 'Solid Color'],
  ],
};

function initAppearance(paint) {
  const root = document.documentElement;
  const dialog = document.getElementById('appearance');
  const opener = document.getElementById('appearance-open');
  const controls = {};
  const storageKey = 'grooveprint.appearance.v1';
  let changed = false;

  for (const [kind, choices] of Object.entries(appearanceOptions)) {
    const select = document.getElementById('appearance-' + kind);
    for (const [key, label] of choices) select.add(new Option(label, key));
    controls[kind] = select;
  }

  const apply = (next = {}) => {
    for (const [kind, choices] of Object.entries(appearanceOptions)) {
      const available = choices.some(([value]) => value === next[kind]);
      const value = available ? next[kind] : choices[0][0];
      root.dataset[kind] = value;
      controls[kind].value = value;
    }
    paint();
  };

  const save = () => {
    changed = true;
    const next = {skin: controls.skin.value, background: controls.background.value};
    apply(next);
    if (macBridge) {
      macBridge.postMessage({action: 'saveAppearance', ...next}).catch(() => {});
    } else {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
    }
  };

  for (const select of Object.values(controls)) select.addEventListener('change', save);
  document.getElementById('appearance-reset').addEventListener('click', () => {
    controls.skin.selectedIndex = controls.background.selectedIndex = 0;
    save();
  });
  opener.addEventListener('click', () => dialog.showModal());
  document.getElementById('appearance-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => opener.focus());

  if (macBridge) {
    macBridge.postMessage({action: 'loadAppearance'}).then(value => {
      if (!changed) apply(value || {});
    }).catch(() => {});
  } else {
    try { apply(JSON.parse(localStorage.getItem(storageKey)) || {}); } catch {}
  }
}
