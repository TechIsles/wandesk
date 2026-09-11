// Theme: follows the system. The resolved value is written to <html data-theme>; the style layer only ever sees "light" or "dark".
const media = window.matchMedia('(prefers-color-scheme: dark)');
const apply = () => { document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'; };

export function initTheme() {
    apply();
    media.addEventListener('change', apply);
}
