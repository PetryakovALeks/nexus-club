/**
 * ═══════════════════════════════════════════════════════════
 *  NEXUS CLUB — API Layer
 *  Единый модуль для всех запросов к Django REST Framework
 * ═══════════════════════════════════════════════════════════
 *
 *  Как использовать на любой странице:
 *    <script src="api.js"></script>
 *
 *  Примеры:
 *    const pcs   = await API.get('/pcs/');
 *    const user  = await API.get('/profile/');
 *    const token = await API.post('/auth/login/', { email, password });
 *    await API.patch('/profile/', { username: 'NewNick' });
 *    await API.delete('/bookings/42/');
 */

/* ─────────────────────────────────────────
   КОНФИГУРАЦИЯ
───────────────────────────────────────── */

const API_CONFIG = {
  // Меняй BASE_URL когда напарник поднимет сервер
  BASE_URL: 'http://localhost:8000/api',

  // Ключи в localStorage
  TOKEN_KEY:   'nexus_token',
  USER_KEY:    'nexus_user',
  REFRESH_KEY: 'nexus_refresh',
};


/* ─────────────────────────────────────────
   ТОКЕН — хранение и чтение
───────────────────────────────────────── */

const Auth = {
  getToken()    { return localStorage.getItem(API_CONFIG.TOKEN_KEY); },
  getRefresh()  { return localStorage.getItem(API_CONFIG.REFRESH_KEY); },
  getUser()     {
    try { return JSON.parse(localStorage.getItem(API_CONFIG.USER_KEY)); }
    catch { return null; }
  },

  setSession(token, refresh, user) {
    localStorage.setItem(API_CONFIG.TOKEN_KEY,   token);
    localStorage.setItem(API_CONFIG.REFRESH_KEY, refresh);
    localStorage.setItem(API_CONFIG.USER_KEY,    JSON.stringify(user));
  },

  clearSession() {
    localStorage.removeItem(API_CONFIG.TOKEN_KEY);
    localStorage.removeItem(API_CONFIG.REFRESH_KEY);
    localStorage.removeItem(API_CONFIG.USER_KEY);
  },

  isLoggedIn()  { return !!this.getToken(); },
  isAdmin()     { return this.getUser()?.role === 'admin'; },
};


/* ─────────────────────────────────────────
   БАЗОВЫЙ fetch — добавляет заголовки,
   обрабатывает 401 и сетевые ошибки
───────────────────────────────────────── */

async function apiFetch(endpoint, options = {}) {
  const url = API_CONFIG.BASE_URL + endpoint;

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Добавляем токен авторизации если он есть
  const token = Auth.getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (networkError) {
    // Сервер недоступен / нет интернета
    throw new APIError(0, 'Нет соединения с сервером. Проверь, что Django запущен.');
  }

  // Токен истёк — пробуем обновить через refresh
  if (response.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      // Повторяем оригинальный запрос с новым токеном
      headers['Authorization'] = `Bearer ${Auth.getToken()}`;
      response = await fetch(url, { ...options, headers });
    } else {
      // Refresh тоже не помог — выгоняем на страницу входа
      Auth.clearSession();
      redirectToLogin();
      return;
    }
  }

  // Пустой ответ (например DELETE возвращает 204)
  if (response.status === 204) return null;

  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new APIError(response.status, extractErrorMessage(data), data);
  }

  return data;
}


/* ─────────────────────────────────────────
   REFRESH токена (JWT)
───────────────────────────────────────── */

async function tryRefreshToken() {
  const refresh = Auth.getRefresh();
  if (!refresh) return false;

  try {
    const res = await fetch(API_CONFIG.BASE_URL + '/auth/token/refresh/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh }),
    });

    if (!res.ok) return false;

    const { access } = await res.json();
    localStorage.setItem(API_CONFIG.TOKEN_KEY, access);
    return true;
  } catch {
    return false;
  }
}


/* ─────────────────────────────────────────
   Класс ошибки API
───────────────────────────────────────── */

class APIError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.name    = 'APIError';
    this.status  = status;
    this.data    = data;
  }
}

// Вытащить читаемое сообщение из тела ошибки Django
function extractErrorMessage(data) {
  if (!data) return 'Неизвестная ошибка';
  if (typeof data === 'string') return data;
  // Django REST Framework возвращает { detail: "..." }
  if (data.detail) return data.detail;
  // Или { field: ["Ошибка"] }
  const firstKey = Object.keys(data)[0];
  if (firstKey) {
    const val = data[firstKey];
    return Array.isArray(val) ? `${firstKey}: ${val[0]}` : String(val);
  }
  return JSON.stringify(data);
}


/* ─────────────────────────────────────────
   ПУБЛИЧНЫЙ API — методы запросов
───────────────────────────────────────── */

const API = {
  get(endpoint, params = {}) {
    const query = Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString()
      : '';
    return apiFetch(endpoint + query, { method: 'GET' });
  },

  post(endpoint, body = {}) {
    return apiFetch(endpoint, {
      method: 'POST',
      body:   JSON.stringify(body),
    });
  },

  patch(endpoint, body = {}) {
    return apiFetch(endpoint, {
      method: 'PATCH',
      body:   JSON.stringify(body),
    });
  },

  put(endpoint, body = {}) {
    return apiFetch(endpoint, {
      method: 'PUT',
      body:   JSON.stringify(body),
    });
  },

  delete(endpoint) {
    return apiFetch(endpoint, { method: 'DELETE' });
  },
};


/* ─────────────────────────────────────────
   ГОТОВЫЕ МЕТОДЫ ДЛЯ КАЖДОЙ СУЩНОСТИ
   Используй их на страницах вместо
   прямых вызовов API.get/post
───────────────────────────────────────── */

const AuthAPI = {
  /** Регистрация. Возвращает { token, refresh, user } */
  async register(payload) {
    const data = await API.post('/auth/register/', payload);
    Auth.setSession(data.token, data.refresh, data.user);
    return data;
  },

  /** Вход. Возвращает { token, refresh, user } */
  async login(email, password) {
    const data = await API.post('/auth/login/', { email, password });
    Auth.setSession(data.token, data.refresh, data.user);
    return data;
  },

  /** Выход — очищает сессию и редиректит */
  async logout() {
    try { await API.post('/auth/logout/'); } catch {}
    Auth.clearSession();
    window.location.href = 'auth.html';
  },
};

const PCsAPI = {
  /** Все ПК. Можно фильтровать: getAll({ zone: 'vip', status: 'free' }) */
  getAll(filters = {})   { return API.get('/pcs/', filters); },
  getOne(id)             { return API.get(`/pcs/${id}/`); },
  update(id, data)       { return API.patch(`/pcs/${id}/`, data); },   // admin
  /** Занятые слоты для конкретного ПК на дату: [{start:'10:00',end:'12:00'},...] */
  getBusySlots(id, date) { return API.get(`/pcs/${id}/busy_slots/`, { date }); },
};

const BookingsAPI = {
  /** Мои бронирования (для текущего пользователя) */
  getMy(filters = {})    { return API.get('/bookings/my/', filters); },
  /** Все бронирования (только для admin) */
  getAll(filters = {})   { return API.get('/bookings/', filters); },
  getOne(id)             { return API.get(`/bookings/${id}/`); },

  /**
   * Создать бронирование
   * @param {{ pc_id, tariff_id, start_time, end_time }} payload
   */
  create(payload)        { return API.post('/bookings/', payload); },
  cancel(id)             { return API.delete(`/bookings/${id}/`); },
};

const TariffsAPI = {
  getAll()               { return API.get('/tariffs/'); },
};

const ProfileAPI = {
  get()                  { return API.get('/profile/'); },
  update(data)           { return API.patch('/profile/', data); },
  /** Пополнить баланс. amount — число рублей */
  topUp(amount)          { return API.post('/payments/topup/', { amount }); },
  getTransactions()      { return API.get('/payments/history/'); },
};

const TournamentsAPI = {
  getAll(filters = {})   { return API.get('/tournaments/', filters); },
  getOne(id)             { return API.get(`/tournaments/${id}/`); },
  join(id)               { return API.post(`/tournaments/${id}/join/`); },
  leave(id)              { return API.delete(`/tournaments/${id}/join/`); },
  getMy()                { return API.get('/tournaments/my/'); },
  // Admin
  create(data)           { return API.post('/tournaments/', data); },
  update(id, data)       { return API.patch(`/tournaments/${id}/`, data); },
  remove(id)             { return API.delete(`/tournaments/${id}/`); },
};

const NewsAPI = {
  getAll(filters = {})   { return API.get('/news/', filters); },
  getOne(id)             { return API.get(`/news/${id}/`); },
  // Admin
  create(data)           { return API.post('/news/', data); },
  update(id, data)       { return API.patch(`/news/${id}/`, data); },
  remove(id)             { return API.delete(`/news/${id}/`); },
  publish(id)            { return API.patch(`/news/${id}/`, { is_published: true }); },
};


/* ─────────────────────────────────────────
   УТИЛИТЫ ДЛЯ СТРАНИЦ
───────────────────────────────────────── */

/**
 * Защита маршрута — вызывай вверху страниц, требующих авторизации.
 * Пример: requireAuth();          // любой пользователь
 *         requireAuth('admin');   // только admin
 */
function requireAuth(role = null) {
  if (!Auth.isLoggedIn()) {
    redirectToLogin();
    return false;
  }
  if (role === 'admin' && !Auth.isAdmin()) {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

/** Редирект на страницу входа, сохраняя текущий URL для возврата */
function redirectToLogin() {
  const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `auth.html?next=${returnTo}`;
}

/**
 * Обновить navbar в зависимости от состояния авторизации.
 * Вызывай после подключения api.js на каждой странице.
 */
function syncNavbar() {
  const user = Auth.getUser();
  const actionsEl = document.querySelector('.nav-actions');
  if (!actionsEl) return;

  if (user) {
    actionsEl.innerHTML = `
      <a href="booking.html" class="btn btn-primary btn-sm">
        <i class='bx bx-calendar-plus'></i> Забронировать
      </a>
      ${user.role === 'admin' ? `<a href="admin.html" class="btn btn-ghost btn-sm"><i class='bx bxs-dashboard'></i></a>` : ''}
      <a href="profile.html" class="btn btn-ghost btn-sm">
        <i class='bx bx-user'></i> ${user.username || 'Профиль'}
      </a>
      <button onclick="AuthAPI.logout()" class="btn btn-ghost btn-sm">
        <i class='bx bx-log-out'></i>
      </button>
    `;
  } else {
    actionsEl.innerHTML = `
      <a href="auth.html" class="btn btn-ghost btn-sm">Войти</a>
      <a href="auth.html" class="btn btn-primary btn-sm">Регистрация</a>
      <button class="nav-burger" onclick="document.getElementById('navMobile').classList.toggle('open')">
        <span></span><span></span><span></span>
      </button>
    `;
  }
}


/**
 * Показать toast-уведомление
 * Пример: showToast('Бронь создана!', 'success')
 *         showToast('Ошибка', 'error')
 */
function showToast(message, type = 'info', duration = 3500) {
  // Создаём контейнер если его нет
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px;
      pointer-events: none;
    `;
    document.body.appendChild(container);
  }

  const colors = {
    success: { bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.3)',  color: '#4ade80', icon: 'bx-check-circle' },
    error:   { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.3)',  color: '#f87171', icon: 'bx-error-circle' },
    info:    { bg: 'rgba(124,58,237,0.12)', border: 'rgba(124,58,237,0.3)', color: '#a78bfa', icon: 'bx-info-circle' },
    warning: { bg: 'rgba(234,179,8,0.12)',  border: 'rgba(234,179,8,0.3)',  color: '#facc15', icon: 'bx-error' },
  };
  const c = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.style.cssText = `
    display: flex; align-items: center; gap: 10px;
    background: ${c.bg}; border: 1px solid ${c.border};
    border-radius: 10px; padding: 12px 18px;
    font-family: 'Exo 2', sans-serif; font-size: 14px; font-weight: 500;
    color: ${c.color}; backdrop-filter: blur(12px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    pointer-events: all; max-width: 340px;
    animation: toastIn 0.3s ease;
  `;
  toast.innerHTML = `<i class='bx ${c.icon}' style="font-size:18px;flex-shrink:0"></i><span>${message}</span>`;

  // CSS для анимации
  if (!document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      @keyframes toastIn  { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
      @keyframes toastOut { from { opacity:1; transform:translateY(0); }   to { opacity:0; transform:translateY(12px); } }
    `;
    document.head.appendChild(style);
  }

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}


/**
 * Показать спиннер загрузки внутри элемента
 * Пример: setLoading(btn, true) / setLoading(btn, false, 'Войти')
 */
function setLoading(element, isLoading, originalText = '') {
  if (isLoading) {
    element.disabled = true;
    element.dataset.originalText = element.innerHTML;
    element.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" style="animation:spin 0.8s linear infinite;flex-shrink:0">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="30 60" />
      </svg>
      Загрузка...
    `;
    if (!document.getElementById('spin-style')) {
      const s = document.createElement('style');
      s.id = 'spin-style';
      s.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(s);
    }
  } else {
    element.disabled = false;
    element.innerHTML = originalText || element.dataset.originalText || element.innerHTML;
  }
}


/**
 * Показать ошибку под полем формы
 * Пример: showFieldError('email', 'Неверный формат email')
 *         clearFieldError('email')
 */
function showFieldError(fieldId, message) {
  clearFieldError(fieldId);
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.style.borderColor = 'var(--red)';
  field.style.boxShadow   = '0 0 0 3px rgba(239,68,68,0.15)';
  const err = document.createElement('div');
  err.className = 'form-error field-error-msg';
  err.id = fieldId + '-error';
  err.textContent = message;
  field.parentNode.insertBefore(err, field.nextSibling);
}

function clearFieldError(fieldId) {
  const field = document.getElementById(fieldId);
  if (field) { field.style.borderColor = ''; field.style.boxShadow = ''; }
  document.getElementById(fieldId + '-error')?.remove();
}

/** Очистить все ошибки формы */
function clearAllErrors(formEl) {
  formEl.querySelectorAll('.field-error-msg').forEach(e => e.remove());
  formEl.querySelectorAll('.form-input').forEach(el => {
    el.style.borderColor = ''; el.style.boxShadow = '';
  });
}


/**
 * Форматировать дату для отображения
 * Пример: formatDate('2025-06-10T18:00:00') → '10 июня 2025, 18:00'
 */
function formatDate(isoString, options = {}) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  const defaults = { day: 'numeric', month: 'long', year: 'numeric' };
  const timeOpts = options.time ? { hour: '2-digit', minute: '2-digit' } : {};
  return d.toLocaleDateString('ru-RU', { ...defaults, ...timeOpts, ...options });
}

/** Форматировать деньги: 1200 → '1 200 ₽' */
function formatMoney(amount) {
  return Number(amount).toLocaleString('ru-RU') + ' ₽';
}


/* ─────────────────────────────────────────
   АВТОЗАПУСК — синхронизировать navbar
   когда DOM готов
───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', syncNavbar);
