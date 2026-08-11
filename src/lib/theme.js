export async function applyTheme() {
  const { theme } = await chrome.storage.local.get('theme');
  if (theme && theme !== 'system') {
    document.documentElement.dataset.theme = theme;
  }
  // Listen for changes from other tabs/pages
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.theme) {
      const val = changes.theme.newValue;
      if (!val || val === 'system') {
        delete document.documentElement.dataset.theme;
      } else {
        document.documentElement.dataset.theme = val;
      }
    }
  });
}
