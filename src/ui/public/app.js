// The token arrives once in the query string and then lives in sessionStorage,
// so refreshing or following a deep link keeps working without it in the URL.
const params = new URLSearchParams(location.search);
const fromUrl = params.get('t');
if (fromUrl) {
  sessionStorage.setItem('tmux-mcp-token', fromUrl);
  params.delete('t');
  history.replaceState({}, '', location.pathname + (params.toString() ? `?${params}` : ''));
}
const token = sessionStorage.getItem('tmux-mcp-token') ?? '';

const status = document.getElementById('status');
const list = document.getElementById('requests');

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

function ageLabel(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

async function renderTargets(request, container) {
  container.textContent = 'Loading…';
  container.className = '';
  try {
    const { targets } = await api(`/api/requests/${request.id}/targets`);
    if (targets.length === 0) {
      container.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: `No ${request.kind} can be assigned right now.`,
      }));
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'targets';
    for (const target of targets) {
      const li = document.createElement('li');
      const assign = Object.assign(document.createElement('button'), { textContent: 'Assign' });
      assign.addEventListener('click', async () => {
        assign.disabled = true;
        try {
          await api(`/api/requests/${request.id}/grant`, {
            method: 'POST',
            body: JSON.stringify({ target: target.id }),
          });
          void refresh();
        } catch (error) {
          assign.disabled = false;
          status.textContent = error.message;
          status.className = 'error';
        }
      });
      li.append(assign, Object.assign(document.createElement('code'), { textContent: target.label }));
      ul.append(li);
    }
    container.replaceChildren(ul);
  } catch (error) {
    container.textContent = error.message;
    container.className = 'error';
  }
}

function renderRequest(request) {
  const card = document.createElement('article');
  card.className = 'request';
  card.id = `request-${request.id}`;

  const head = document.createElement('p');
  head.append(
    Object.assign(document.createElement('span'), { className: 'reason', textContent: request.reason }),
    ' ',
    Object.assign(document.createElement('span'), { className: 'age', textContent: ageLabel(request.ageSeconds) }),
  );

  const targets = document.createElement('div');

  // The list is a live view: a pane opened just now appears after this.
  const refreshBtn = Object.assign(document.createElement('button'), { textContent: 'Refresh list' });
  refreshBtn.addEventListener('click', () => void renderTargets(request, targets));

  const denyBtn = Object.assign(document.createElement('button'), { textContent: 'Deny' });
  denyBtn.addEventListener('click', async () => {
    denyBtn.disabled = true;
    try {
      await api(`/api/requests/${request.id}/deny`, {
        method: 'POST',
        body: JSON.stringify({ reason: '' }),
      });
      void refresh();
    } catch (error) {
      denyBtn.disabled = false;
      status.textContent = error.message;
      status.className = 'error';
    }
  });

  card.append(head, refreshBtn, ' ', denyBtn, targets);
  void renderTargets(request, targets);
  return card;
}

async function refresh() {
  try {
    const { requests } = await api('/api/requests');
    list.replaceChildren(Object.assign(document.createElement('h2'), { textContent: 'Pending requests' }));
    if (requests.length === 0) {
      list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Nothing is waiting.' }));
    } else {
      for (const request of requests) list.append(renderRequest(request));
    }
    status.textContent = `${requests.length} pending`;
    status.className = '';

    const deep = location.pathname.match(/^\/r\/(.+)$/);
    if (deep) document.getElementById(`request-${deep[1]}`)?.scrollIntoView();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'error';
  }
}

const events = new EventSource(`/events?t=${encodeURIComponent(token)}`);
events.addEventListener('request-added', event => {
  void refresh();
  const data = JSON.parse(event.data);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('tmux-mcp: an agent wants a pane', { body: data.reason });
  }
});
events.addEventListener('request-answered', () => void refresh());

if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  void Notification.requestPermission();
}

void refresh();
