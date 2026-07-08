import {
  isChromeNewTabUrl,
  isHttpUrl,
  isPdfContentType,
  isPdfLikeUrl,
  parseViewableUrl
} from './core/pdf-url';

const VIEWER_PATH = 'viewer.html';
const HUB_PATH = 'hub.html';
const SETTINGS_KEY = 'margin:settings';
const UNSUPPORTED_NOTICE = 'Margin은 PDF 문서에서만 열 수 있어요. PDF 링크나 로컬 PDF 파일에서 다시 눌러 주세요.';
const UNSUPPORTED_NOTIFICATION_TITLE = 'Margin';
const UNSUPPORTED_NOTIFICATION_MESSAGE = 'PDF 문서에서만 열 수 있어요. PDF 탭에서 다시 눌러 주세요.';
const ICON_128 = 'icons/icon-128.png';

type Settings = {
  autoIntercept?: boolean;
};

type PdfResponseStatus = 'pdf' | 'not-pdf' | 'unknown';

function viewerUrl(file?: string): string {
  const base = chrome.runtime.getURL(VIEWER_PATH);
  return file ? `${base}?file=${encodeURIComponent(file)}` : base;
}

function ownExtensionUrl(): string {
  return chrome.runtime.getURL('');
}

function tabUrl(tab: chrome.tabs.Tab): string | undefined {
  const pendingUrl = (tab as chrome.tabs.Tab & { pendingUrl?: string }).pendingUrl;
  return pendingUrl ?? tab.url;
}

function isOwnExtensionPage(rawUrl: string): boolean {
  return rawUrl.startsWith(ownExtensionUrl());
}

async function detectPdfResponse(url: string): Promise<PdfResponseStatus> {
  const controller = new AbortController();
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type');
    if (isPdfContentType(contentType) || isPdfLikeUrl(response.url)) return 'pdf';
    return contentType ? 'not-pdf' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    controller.abort();
  }
}

async function showUnsupportedNotification(): Promise<void> {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON_128),
      title: UNSUPPORTED_NOTIFICATION_TITLE,
      message: UNSUPPORTED_NOTIFICATION_MESSAGE
    });
  } catch {
    // OS-level notifications may be unavailable or disabled; Chrome exposes no reliable visibility signal.
  }
}

async function showUnsupportedNotice(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [UNSUPPORTED_NOTICE],
      func: (message: string) => {
        const existing = document.getElementById('margin-action-notice');
        existing?.remove();

        const notice = document.createElement('div');
        notice.id = 'margin-action-notice';
        notice.textContent = message;
        Object.assign(notice.style, {
          position: 'fixed',
          top: '16px',
          right: '16px',
          zIndex: '2147483647',
          maxWidth: '320px',
          padding: '12px 14px',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          borderRadius: '8px',
          background: '#27241f',
          color: '#fffaf0',
          boxShadow: '0 14px 32px rgba(0, 0, 0, 0.22)',
          font: '13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          whiteSpace: 'normal'
        });

        document.documentElement.append(notice);
        window.setTimeout(() => notice.remove(), 3600);
      }
    });
  } catch {
    await showUnsupportedNotification();
  }
}

async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return got[SETTINGS_KEY] ?? { autoIntercept: true };
}

async function syncInterceptRules(): Promise<void> {
  const settings = await getSettings();
  const auto = settings.autoIntercept ?? true;
  const viewer = chrome.runtime.getURL(VIEWER_PATH);

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2, 3] });
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
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame']
        },
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${viewer}?file=\\0` }
        }
      },
      {
        id: 3,
        priority: 1,
        condition: {
          regexFilter: '^file://.*\\.pdf$',
          isUrlFilterCaseSensitive: false,
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

async function syncAutoOpenMenuChecked(): Promise<void> {
  const settings = await getSettings();
  try {
    await chrome.contextMenus.update('auto-open', { checked: settings.autoIntercept ?? true });
  } catch {
    // The menu can be absent during development reloads before onInstalled recreates it.
  }
}

async function setupContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'open-hub',
    title: '메모 허브 열기',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'auto-open',
    type: 'checkbox',
    title: 'PDF 자동으로 Margin에서 열기',
    contexts: ['action']
  });
  await syncAutoOpenMenuChecked();
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupContextMenus();
  await syncInterceptRules();
});

chrome.runtime.onStartup.addListener(() => {
  void syncAutoOpenMenuChecked();
  void syncInterceptRules();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'open-hub') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(HUB_PATH) });
    return;
  }

  if (info.menuItemId === 'auto-open') {
    // 뷰어가 같은 키에 다른 설정(펜 테마 등)을 저장하므로 병합해서 쓴다.
    const settings = await getSettings();
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...settings, autoIntercept: Boolean(info.checked) }
    });
    await syncInterceptRules();
    await syncAutoOpenMenuChecked();
  }
});

async function isAllowedFileSchemeAccess(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

async function handleLocalPdfNavigation(details: chrome.webNavigation.WebNavigationBaseCallbackDetails): Promise<void> {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const settings = await getSettings();
  if (settings.autoIntercept === false) return;
  if (await isAllowedFileSchemeAccess()) return;
  try {
    await chrome.tabs.update(details.tabId, { url: viewerUrl(details.url) });
  } catch {
    // 판별을 기다리는 사이 탭이 닫혔거나 다른 곳으로 이동한 레이스 — 무시.
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    void handleLocalPdfNavigation(details);
  },
  {
    url: [
      { urlPrefix: 'file://', pathSuffix: '.pdf' },
      { urlPrefix: 'file://', pathSuffix: '.PDF' }
    ]
  }
);

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  const rawUrl = tabUrl(tab);
  if (!rawUrl || isChromeNewTabUrl(rawUrl)) {
    await chrome.tabs.update(tab.id, { url: viewerUrl() });
    return;
  }
  if (isOwnExtensionPage(rawUrl)) return;

  const url = parseViewableUrl(rawUrl);
  if (!url) {
    await showUnsupportedNotice(tab.id);
    return;
  }

  if (isPdfLikeUrl(rawUrl)) {
    await chrome.tabs.update(tab.id, { url: viewerUrl(rawUrl) });
    return;
  }

  if (isHttpUrl(url)) {
    const status = await detectPdfResponse(rawUrl);
    if (status === 'not-pdf') {
      await showUnsupportedNotice(tab.id);
      return;
    }
    await chrome.tabs.update(tab.id, { url: viewerUrl(rawUrl) });
    return;
  }

  await showUnsupportedNotice(tab.id);
});
