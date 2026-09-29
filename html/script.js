const root = document.documentElement;
const toggleBtn = document.getElementById('theme-toggle');
const toggleText = document.getElementById('theme-toggle-text');

document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const value = btn.dataset.copy;
        navigator.clipboard.writeText(value).then(() => {
            const original = btn.textContent;
            btn.textContent = 'Copied!';
            btn.disabled = true;
            setTimeout(() => {
                btn.textContent = original;
                btn.disabled = false;
            }, 3000);
        });
    });
});

function applyTheme(theme) {
    if (theme === 'light') {
        root.setAttribute('data-theme', 'light');
        toggleText.textContent = 'light';
    } else {
        root.removeAttribute('data-theme');
        toggleText.textContent = 'dark';
    }
}

const saved = localStorage.getItem('theme');
if (saved) {
    applyTheme(saved);
} else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    applyTheme('light');
}

toggleBtn.addEventListener('click', () => {
    const isLight = root.getAttribute('data-theme') === 'light';
    const next = isLight ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('theme', next);
});