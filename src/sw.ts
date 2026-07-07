import { isHttpUrl, isPdfContentType, isPdfLikeUrl, parseViewableUrl } from './core/pdf-url';

const VIEWER_PATH = 'viewer.html';
const HUB_PATH = 'hub.html';
const SETTINGS_KEY = 'margin:settings';
const ACTION_TITLE = 'Margin으로 열기';
const UNSUPPORTED_NOTICE = 'Margin은 PDF 문서에서만 열 수 있어요. PDF 링크나 로컬 PDF 파일에서 다시 눌러 주세요.';

type Settings = {
  autoIntercept?: boolean;
};

function viewerUrl(file?: string): string {
  const base = chrome.runtime.getURL(VIEWER_PATH);
  return file ? `${base}?file=${encodeURIComponent(file)}` : base;
}

async function urlRespondsAsPdf(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store'
    });
    return isPdfContentType(response.headers.get('content-type')) || isPdfLikeUrl(response.url);
  } catch {
    return false;
  }
}

async function canOpenInViewer(rawUrl: string): Promise<boolean> {
  const url = parseViewableUrl(rawUrl);
  if (!url) return false;
  if (isPdfLikeUrl(rawUrl)) return true;
  if (!isHttpUrl(url)) return false;
  return urlRespondsAsPdf(rawUrl);
}

async function flashActionBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#9F2D20' });
  await chrome.action.setBadgeText({ tabId, text: 'PDF' });
  await chrome.action.setTitle({ tabId, title: UNSUPPORTED_NOTICE });
  await new Promise((resolve) => {
    setTimeout(resolve, 2400);
  });
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: ACTION_TITLE });
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
    await flashActionBadge(tabId);
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
    // 뷰어가 같은 키에 다른 설정(펜 테마 등)을 저장하므로 병합해서 쓴다.
    const settings = await getSettings();
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...settings, autoIntercept: Boolean(info.checked) }
    });
    await syncInterceptRules();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  if (!(await canOpenInViewer(tab.url))) {
    await showUnsupportedNotice(tab.id);
    return;
  }
  await chrome.tabs.update(tab.id, { url: viewerUrl(tab.url) });
});
