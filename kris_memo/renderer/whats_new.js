async function init() {
  const info = await window.api.getWhatsNew();
  document.getElementById('version-badge').textContent = `✦ NEW  v${info.version}`;

  const list = document.getElementById('change-list');
  (info.changes || []).forEach(item => {
    const div = document.createElement('div');
    div.className = 'change-item';
    div.innerHTML = `
      <div class="change-icon" style="background:${item.color}22;">${item.icon}</div>
      <div class="change-text">
        <div class="change-title">${item.title}</div>
        ${item.desc ? `<div class="change-desc">${item.desc}</div>` : ''}
      </div>
    `;
    list.appendChild(div);
  });

  document.fonts.ready.then(() => {
    requestAnimationFrame(() => {
      const frame = document.getElementById('win-frame');
      window.api.resizeWhatsNew(frame.offsetWidth, frame.offsetHeight);
    });
  });
}

document.getElementById('btn-confirm').onclick = async () => {
  await window.api.closeWhatsNew();
};

init();
