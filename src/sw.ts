const VIEWER_PATH = 'viewer.html';
const HUB_PATH = 'hub.html';
const SETTINGS_KEY = 'margin:settings';

type Settings = {
  autoIntercept?: boolean;
};

function viewerUrl(file?: string): string {
  const base = chrome.runtime.getURL(VIEWER_PATH);
  return file ? `${base}?file=${encodeURIComponent(file)}` : base;
}

async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return got[SETTINGS_KEY] ?? { autoIntercept: true };
}

async function syncInterceptRules(): Promise<void> {
  const settings = await getSettings();
  const auto = settings.autoIntercept ?? true;
  const viewer = chrome.runtime.getURL(VIEWER_PATH);

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2] });
  if (!auto) return;

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id: 1,
        priority: 1,
        condition: {
          regexFilter: '^https://arxiv\\.org/pdf/[^?#]+',
          resourceTypes: ['main_frame']
        },
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${viewer}?file=\\0` }
        }
      },
      {
        id: 2,
        priority: 1,
        condition: {
          regexFilter: '^https?://.+\\.pdf([?#].*)?$',
          resourceTypes: ['main_frame']
        },
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${viewer}?file=\\0` }
        }
      }
    ]
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: 'open-hub',
    title: '메모 허브 열기',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'auto-open',
    type: 'checkbox',
    checked: true,
    title: 'PDF 자동으로 Margin에서 열기',
    contexts: ['action']
  });
  await syncInterceptRules();
});

chrome.runtime.onStartup.addListener(syncInterceptRules);

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'open-hub') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(HUB_PATH) });
    return;
  }

  if (info.menuItemId === 'auto-open') {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { autoIntercept: Boolean(info.checked) }
    });
    await syncInterceptRules();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  await chrome.tabs.update(tab.id, { url: viewerUrl(tab.url) });
});

