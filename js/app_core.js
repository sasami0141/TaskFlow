// --- Meta data fetcher ---
async function fetchUrlMetadata(url) {
    try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error('Network error');
        const data = await response.json();
        const html = data.contents;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const title = doc.querySelector('title')?.innerText || doc.querySelector('meta[property="og:title"]')?.content || '';
        const description = doc.querySelector('meta[property="og:description"]')?.content || doc.querySelector('meta[name="description"]')?.content || '';
        const image = doc.querySelector('meta[property="og:image"]')?.content || '';
        return { title: title.trim(), description: description.trim(), image };
    } catch (e) {
        return { title: '', description: '', image: '' };
    }
}

// --- Database Module ---
const DB_NAME = 'TaskFlowDB';
const DB_VERSION = 1;
const GAS_SYNC_URL_KEY = 'taskflowGasSyncUrl';
const GAS_SYNC_API_KEY = 'taskflowGasApiKey';
let dbInstance = null;
let taskSyncTimer = null;
let taskSyncInProgress = false;
let taskSyncPending = false;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('tasks')) {
                const store = db.createObjectStore('tasks', { keyPath: 'id' });
                store.createIndex('deadline', 'deadline', { unique: false });
                store.createIndex('completed', 'completed', { unique: false });
            }
        };
        request.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
        request.onerror = (e) => reject(e.target.error);
    });
}
function getDB() { return dbInstance; }
function generateId() { return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9); }
function getGasSyncUrl() {
    try {
        return localStorage.getItem(GAS_SYNC_URL_KEY) || '';
    } catch (error) {
        console.warn('Unable to read the GAS sync URL from local storage.', error);
        updateGasSyncStatus('同期先を読み込めません。ブラウザーのストレージ設定を確認してください。');
        return '';
    }
}
function getGasSyncApiKey() {
    try {
        return (localStorage.getItem(GAS_SYNC_API_KEY) || '').trim();
    } catch (error) {
        console.warn('Unable to read the GAS API key from local storage.', error);
        updateGasSyncStatus('APIキーを読み込めません。ブラウザーのストレージ設定を確認してください。');
        return '';
    }
}
function isValidGasSyncUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            url.hostname === 'script.google.com' &&
            /^\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname);
    } catch (error) {
        return false;
    }
}
function updateGasSyncStatus(message) {
    const status = document.getElementById('gas-sync-status');
    if (status) status.textContent = message;
}
function scheduleTaskSync() {
    const url = getGasSyncUrl();
    const apiKey = getGasSyncApiKey();
    if (!url || !apiKey) return;
    if (!isValidGasSyncUrl(url)) {
        updateGasSyncStatus('保存済みのGAS URLが無効です。設定を確認してください。');
        return;
    }
    clearTimeout(taskSyncTimer);
    taskSyncTimer = setTimeout(() => {
        taskSyncTimer = null;
        syncTasksToGas();
    }, 300);
}
async function syncTasksToGas() {
    const url = getGasSyncUrl();
    const apiKey = getGasSyncApiKey();
    if (!url || !apiKey || !isValidGasSyncUrl(url)) return;
    if (taskSyncInProgress) {
        taskSyncPending = true;
        return;
    }

    taskSyncInProgress = true;
    updateGasSyncStatus('最新のタスクを同期中...');
    try {
        const tasks = await getAllTasks();
        await fetch(url, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ apiKey, tasks })
        });
        updateGasSyncStatus('同期リクエストを送信しました。受信結果はGAS側で確認してください。');
    } catch (error) {
        console.warn('GAS task sync failed; local tasks remain saved.', error);
        updateGasSyncStatus('同期に失敗しました。ローカルデータは保存済みです。接続復帰後に再試行します。');
    } finally {
        taskSyncInProgress = false;
        if (taskSyncPending) {
            taskSyncPending = false;
            scheduleTaskSync();
        }
    }
}
function calculateDate(baseDateStr, type, amount) {
    const d = baseDateStr ? new Date(baseDateStr) : new Date();
    if (type === 'days') d.setDate(d.getDate() + amount);
    else if (type === 'weeks') d.setDate(d.getDate() + (amount * 7));
    else if (type === 'months') {
        const currentDay = d.getDate();
        d.setMonth(d.getMonth() + amount);
        if (d.getDate() !== currentDay) d.setDate(0); 
    }
    const tzOffset = d.getTimezoneOffset() * 60000;
    return (new Date(d - tzOffset)).toISOString().slice(0, 16);
}

function toDatetimeLocalValue(dateValue) {
    if (!dateValue) return '';
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function saveTask(task) {
    const db = getDB();
    if(!task.id) task.id = generateId();
    if(!task.createdAt) task.createdAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').put(task);
        tx.oncomplete = () => {
            resolve(task);
            scheduleTaskSync();
        };
        tx.onerror = () => reject(tx.error || new Error('Failed to save task.'));
        tx.onabort = () => reject(tx.error || new Error('Task save was aborted.'));
    });
}
function getAllTasks() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readonly');
        const req = tx.objectStore('tasks').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Failed to load tasks.'));
    });
}
function deleteTask(id) {
    const db = getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').delete(id);
        tx.oncomplete = () => {
            resolve();
            scheduleTaskSync();
        };
        tx.onerror = () => reject(tx.error || new Error('Failed to delete task.'));
        tx.onabort = () => reject(tx.error || new Error('Task deletion was aborted.'));
    });
}
function replaceAllTasks(tasks) {
    const db = getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        const store = tx.objectStore('tasks');
        store.clear();
        for (const task of tasks) {
            if (!task.id) task.id = generateId();
            if (!task.createdAt) task.createdAt = new Date().toISOString();
            store.put(task);
        }
        tx.oncomplete = () => {
            resolve();
            scheduleTaskSync();
        };
        tx.onerror = () => reject(tx.error || new Error('Failed to restore tasks.'));
        tx.onabort = () => reject(tx.error || new Error('Task restore was aborted.'));
    });
}
async function toggleTaskStatus(task) {
    task.completed = !task.completed;
    if(task.completed && task.recurring && task.recurring !== 'none') {
        let newDateStr = calculateDate(task.deadline, 'days', 1);
        const nextTask = {
            ...task,
            id: generateId(),
            completed: false,
            deadline: newDateStr,
            deadlineAt: new Date(newDateStr).toISOString(),
            notificationMode: task.notificationMode === 'custom' ? 'none' : task.notificationMode,
            notificationAt: ''
        };
        await saveTask(nextTask);
    }
    return saveTask(task);
}

// --- PWA Update Module ---
function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        newWorker.postMessage({ action: 'skipWaiting' });
                    }
                });
            });
        }).catch(error => console.warn('Service worker registration failed.', error));
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) { refreshing = true; window.location.reload(); }
        });
    }
}
function fetchAppVersion() {
    return fetch('sw.js', {cache: 'no-store'}).then(res => {
        if (!res.ok) throw new Error(`Version check failed: ${res.status}`);
        return res.text();
    }).then(text => {
        const match = text.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
        if (!match || !/^v-\d+$/.test(match[1])) throw new Error('The app version could not be read.');
        document.getElementById('app-version-info').innerText = `現在のバージョン: ${match[1]}`;
        return match[1];
    });
}

// --- Application Logic ---
let currentTasks = [];
let calDate = new Date();
let selectedDateStr = null;
let currentExtraDates = []; 

document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    setupUI();
    await loadTasks();
    setupServiceWorker();
    fetchAppVersion().catch(error => console.warn('Unable to read the app version.', error));
    if (getGasSyncUrl()) scheduleTaskSync();
    window.addEventListener('online', scheduleTaskSync);
});

// 手動更新チェック
window.handleManualUpdate = async function(btn) {
    const originalText = btn.innerHTML;
    btn.innerHTML = '🔄 更新を確認中...';
    btn.disabled = true;
    btn.style.opacity = '0.6';

    try {
        const version = await fetchAppVersion();
        if (!('serviceWorker' in navigator)) throw new Error('Service workers are not supported.');
        const reg = await navigator.serviceWorker.getRegistration() || await navigator.serviceWorker.register('./sw.js');
        await reg.update();
        alert(`バージョン ${version} を確認しました。新しいバージョンがある場合は自動的にリロードされます。`);
    } catch (err) {
        console.warn('Manual update check failed.', err);
        alert('更新の確認に失敗しました。インターネット接続を確認してください。');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
        btn.style.opacity = '1';
    }
};

// データの復元
window.handleRestoreData = async function(inputElem) {
    if (!inputElem.files || inputElem.files.length === 0) return; // 選択キャンセル時

    const file = inputElem.files[0];
    const label = document.getElementById('label-restore');
    const originalLabelText = label.innerText;
    label.innerText = '⏳ 読み込み中...';
    label.style.opacity = '0.7';
    try {
        const contents = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('File read failed.'));
            reader.onabort = () => reject(new Error('File read was aborted.'));
            reader.readAsText(file);
        });
        const tasks = JSON.parse(contents);
        if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task !== 'object' || Array.isArray(task))) {
            alert('エラー: バックアップファイル（JSON）の形式が正しくありません。');
            return;
        }

        if (confirm(`読み込んだ ${tasks.length} 件のデータで復元しますか？\n※現在のデータは完全に上書き消去されます。`)) {
            await replaceAllTasks(tasks);
            await loadTasks();
            if (document.getElementById('view-stats').classList.contains('active')) updateStats();
            alert(`${tasks.length} 件のデータの復元が完了しました！`);
        }
    } catch (err) {
        console.warn('Task restore failed.', err);
        alert('ファイルの読み込みまたは復元に失敗しました。JSON形式とデータ内容を確認してください。');
    } finally {
        inputElem.value = '';
        label.innerText = originalLabelText;
        label.style.opacity = '1';
    }
};


function setupUI() {
    const updateButton = document.getElementById('btn-manual-update');
    updateButton.addEventListener('click', event => window.handleManualUpdate(event.currentTarget));
    const restoreInput = document.getElementById('input-restore');
    restoreInput.addEventListener('change', () => window.handleRestoreData(restoreInput));

    const gasUrlInput = document.getElementById('gas-sync-url');
    const gasApiKeyInput = document.getElementById('gas-sync-api-key');
    const savedGasUrl = getGasSyncUrl();
    const savedGasApiKey = getGasSyncApiKey();
    gasUrlInput.value = savedGasUrl;
    gasApiKeyInput.value = savedGasApiKey;
    if (savedGasUrl && !isValidGasSyncUrl(savedGasUrl)) updateGasSyncStatus('保存済みのGAS URLが無効です。設定を確認してください。');
    else if (savedGasUrl && savedGasApiKey) updateGasSyncStatus('設定済み。タスクの追加・更新・削除時にバックグラウンド送信します。');
    else updateGasSyncStatus('URLとAPIキーの両方を設定すると同期します。未設定の間、タスクは外部送信されません。');

    document.getElementById('btn-save-gas-url').addEventListener('click', () => {
        const value = gasUrlInput.value.trim();
        const apiKey = gasApiKeyInput.value.trim();
        if (value && !isValidGasSyncUrl(value)) {
            updateGasSyncStatus('https://script.google.com/macros/s/.../exec のURLを入力してください。');
            return alert('有効なGAS WebアプリURL（script.google.com/macros/s/.../exec）を入力してください。');
        }
        try {
            if (value) localStorage.setItem(GAS_SYNC_URL_KEY, value);
            else localStorage.removeItem(GAS_SYNC_URL_KEY);
            if (apiKey) localStorage.setItem(GAS_SYNC_API_KEY, apiKey);
            else localStorage.removeItem(GAS_SYNC_API_KEY);
            if (!value || !apiKey) {
                updateGasSyncStatus('URLとAPIキーの両方を設定すると同期します。未設定の間、タスクは外部送信されません。');
                return;
            }
            updateGasSyncStatus('同期設定を保存しました。最新のタスクをバックグラウンド送信します。');
            scheduleTaskSync();
        } catch (error) {
            console.warn('Unable to save the GAS sync settings.', error);
            alert('同期設定を保存できませんでした。ブラウザーのストレージ設定を確認してください。');
        }
    });

    document.getElementById('theme-toggle').addEventListener('click', () => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    });

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            const targetBtn = e.target.closest('.nav-item');
            targetBtn.classList.add('active');
            const targetId = targetBtn.dataset.target;
            document.getElementById(targetId).classList.add('active');
            if(targetId === 'view-calendar') renderCalendar();
            if(targetId === 'view-stats') updateStats();
        });
    });

    document.getElementById('fab-add').addEventListener('click', () => openModal());
    document.getElementById('btn-cancel').addEventListener('click', () => document.getElementById('task-modal').classList.add('hidden'));
    
    document.getElementById('btn-add-url').addEventListener('click', () => addUrlField());
    document.getElementById('btn-add-image').addEventListener('click', () => addImageField());
    document.getElementById('btn-add-subtask').addEventListener('click', () => addSubtaskField());
    document.getElementById('btn-add-extra-date').addEventListener('click', () => {
        const input = document.getElementById('extra-date-input');
        if (input.value && !currentExtraDates.includes(input.value)) {
            currentExtraDates.push(input.value);
            renderExtraDates();
            input.value = '';
        }
    });
    const notificationModeInput = document.getElementById('task-notification-mode');
    const notificationTimeGroup = document.getElementById('task-notification-time-group');
    notificationModeInput.addEventListener('change', () => {
        notificationTimeGroup.style.display = notificationModeInput.value === 'custom' ? 'block' : 'none';
    });

    document.getElementById('btn-save').addEventListener('click', async () => {
        const title = document.getElementById('task-title').value;
        if(!title) return alert('タスク名を入力してください');
        const notificationMode = notificationModeInput.value;
        const notificationAtInput = document.getElementById('task-notification-at').value;
        if (notificationMode === 'custom' && !notificationAtInput) return alert('通知日時を入力してください');
        const notificationAt = notificationMode === 'custom' ? new Date(notificationAtInput) : null;
        if (notificationAt && Number.isNaN(notificationAt.getTime())) return alert('有効な通知日時を入力してください');
        
        const subtasks = Array.from(document.querySelectorAll('.st-input')).map(input => ({
            id: input.dataset.id, title: input.value, completed: input.dataset.completed === 'true'
        })).filter(st => st.title.trim() !== '');

        const urls = Array.from(document.querySelectorAll('.url-input-item')).map(div => ({
            name: div.querySelector('.url-name').value.trim(),
            url: div.querySelector('.url-val').value.trim(),
            description: div.querySelector('.url-desc').value,
            image: div.querySelector('.url-img').value
        })).filter(u => u.url !== '');

        const images = Array.from(document.querySelectorAll('.img-input-item')).map(div => ({
            name: div.querySelector('.img-name').value.trim() || '画像',
            data: div.querySelector('.img-data').value
        })).filter(i => i.data !== '');

        const task = {
            id: document.getElementById('task-id').value || null,
            title, 
            startDate: document.getElementById('task-start').value,
            deadline: document.getElementById('task-deadline').value,
            deadlineAt: document.getElementById('task-deadline').value ? new Date(document.getElementById('task-deadline').value).toISOString() : '',
            notificationMode,
            notificationAt: notificationAt ? notificationAt.toISOString() : '',
            priority: document.getElementById('task-priority').value,
            recurring: document.getElementById('task-recurring').value,
            memo: document.getElementById('task-memo').value,
            completed: document.getElementById('task-id').dataset.completed === 'true',
            extraDates: currentExtraDates, urls, images, subtasks
        };
        await saveTask(task);
        document.getElementById('task-modal').classList.add('hidden');
        loadTasks();
        if (document.getElementById('view-calendar').classList.contains('active')) renderCalendar(selectedDateStr);
    });

    document.getElementById('search-input').addEventListener('input', renderTasks);
    document.getElementById('filter-status').addEventListener('change', renderTasks);
    document.getElementById('sort-select').addEventListener('change', renderTasks);
    
    const btnRequestNotify = document.getElementById('btn-request-notify');
    if (btnRequestNotify) {
        btnRequestNotify.addEventListener('click', async () => {
            if (!("Notification" in window)) return alert("通知機能非対応です。");
            let permission = Notification.permission;
            if (permission !== "granted" && permission !== "denied") permission = await Notification.requestPermission();
            alert(permission === "granted" ? "通知が許可されました！" : "通知設定を確認してください。");
        });
    }

    const btnBackup = document.getElementById('btn-backup');
    if (btnBackup) {
        btnBackup.addEventListener('click', async () => {
            const tasks = await getAllTasks();
            if (tasks.length === 0) return alert("データがありません。");
            const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `taskflow_backup.json`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        });
    }

    const btnClearAll = document.getElementById('btn-clear-all');
    if (btnClearAll) {
        btnClearAll.addEventListener('click', async () => {
            if (confirm('⚠️ すべてのデータを消去しますか？')) {
                const db = getDB();
                const tx = db.transaction('tasks', 'readwrite');
                tx.objectStore('tasks').clear();
                tx.oncomplete = () => {
                    scheduleTaskSync();
                    alert('消去しました。');
                    loadTasks();
                    updateStats();
                };
            }
        });
    }
}

function openModal(task = null, defaultDateStr = null) {
    document.getElementById('modal-title').innerText = task ? '詳細を編集' : '新しいタスク';
    document.getElementById('task-id').value = task ? task.id : '';
    document.getElementById('task-id').dataset.completed = task ? task.completed : 'false';
    document.getElementById('task-title').value = task ? task.title : '';
    document.getElementById('task-start').value = task && task.startDate ? task.startDate : '';
    document.getElementById('task-deadline').value = task ? task.deadline : (defaultDateStr ? defaultDateStr + 'T12:00' : '');
    document.getElementById('task-notification-mode').value = task && task.notificationMode ? task.notificationMode : 'none';
    document.getElementById('task-notification-at').value = task && task.notificationAt ? toDatetimeLocalValue(task.notificationAt) : '';
    document.getElementById('task-notification-time-group').style.display = document.getElementById('task-notification-mode').value === 'custom' ? 'block' : 'none';
    document.getElementById('task-priority').value = task ? task.priority : '2';
    document.getElementById('task-recurring').value = task && task.recurring ? task.recurring : 'none';
    document.getElementById('task-memo').value = task && task.memo ? task.memo : '';
    
    currentExtraDates = task && task.extraDates ? [...task.extraDates] : [];
    renderExtraDates();
    
    document.getElementById('urls-container').innerHTML = '';
    if (task && task.urls) task.urls.forEach(u => addUrlField(u.name, u.url, u.description, u.image));
    
    document.getElementById('images-container').innerHTML = '';
    if (task && task.images) task.images.forEach(i => addImageField(i.name, i.data));
    
    const stContainer = document.getElementById('subtasks-container');
    stContainer.innerHTML = '';
    if(task && task.subtasks) {
        task.subtasks.forEach(st => addSubtaskField(st.title, st.completed, st.id));
    }
    
    document.getElementById('task-modal').classList.remove('hidden');
}

function renderExtraDates() {
    const container = document.getElementById('extra-dates-container');
    container.innerHTML = '';
    currentExtraDates.sort().forEach((dateStr, index) => {
        const div = document.createElement('div');
        div.className = 'extra-date-item';
        div.innerHTML = `<span>${dateStr}</span> <button type="button" class="btn-remove-date">×</button>`;
        div.querySelector('.btn-remove-date').onclick = () => { currentExtraDates.splice(index, 1); renderExtraDates(); };
        container.appendChild(div);
    });
}

function addUrlField(name = '', url = '', description = '', image = '') {
    const container = document.getElementById('urls-container');
    const div = document.createElement('div');
    div.className = 'multi-item url-input-item';
    div.innerHTML = `<button type="button" class="btn-remove-item">×</button>
        <div class="multi-item-row"><span style="font-size: 12px; width: 40px;">URL</span><input type="url" class="url-val" placeholder="https://..." value="${url}"></div>
        <div class="multi-item-row"><span style="font-size: 12px; width: 40px;">名前</span><input type="text" class="url-name" placeholder="リンクの名前" value="${name}"></div>
        <input type="hidden" class="url-desc" value="${description}"><input type="hidden" class="url-img" value="${image}">`;
    div.querySelector('.btn-remove-item').onclick = () => div.remove();
    container.appendChild(div);
}

function addImageField(name = '', data = '') {
    const container = document.getElementById('images-container');
    const div = document.createElement('div');
    div.className = 'multi-item img-input-item';
    div.innerHTML = `<button type="button" class="btn-remove-item">×</button>
        <div class="multi-item-row"><span style="font-size: 12px; width: 40px;">名前</span><input type="text" class="img-name" placeholder="画像の名前" value="${name}"></div>
        <div class="multi-item-row"><input type="file" class="img-file" accept="image/*" style="font-size: 12px;"><input type="hidden" class="img-data" value="${data}"></div>
        <img class="attachment-preview img-preview" style="display:${data ? 'block' : 'none'};" src="${data}">`;
    div.querySelector('.btn-remove-item').onclick = () => div.remove();
    div.querySelector('.img-file').addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = evt => {
                div.querySelector('.img-data').value = evt.target.result;
                div.querySelector('.img-preview').src = evt.target.result;
                div.querySelector('.img-preview').style.display = 'block';
            };
            reader.readAsDataURL(file);
        }
    });
    container.appendChild(div);
}

function addSubtaskField(title = '', completed = false, id = null) {
    const container = document.getElementById('subtasks-container');
    const div = document.createElement('div');
    div.className = 'subtask-item';
    div.innerHTML = `<input type="text" placeholder="サブタスクを入力..." data-id="${id || generateId()}" data-completed="${completed}" value="${title}" class="st-input"><button type="button" class="btn-st-del">×</button>`;
    div.querySelector('.btn-st-del').onclick = () => div.remove();
    container.appendChild(div);
}

async function loadTasks() { currentTasks = await getAllTasks(); renderTasks(); }

function applySwipeToDelete(wrapperEl, taskItemEl, task) {
    let startX = 0, currentX = 0, isDragging = false, lastMoveX = 0;
    
    const startDrag = (e) => {
        if (e.target.closest('input') || e.target.closest('a')) return;
        startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        currentX = 0; lastMoveX = 0; isDragging = true;
        taskItemEl.style.transition = 'none';
    };
    const moveDrag = (e) => {
        if (!isDragging) return;
        currentX = (e.type.includes('touch') ? e.touches[0].clientX : e.clientX) - startX;
        lastMoveX = currentX;
        taskItemEl.style.transform = `translateX(${currentX}px)`;
        const swipeBg = wrapperEl.querySelector('.task-swipe-bg');
        if (currentX > 0) {
            swipeBg.querySelector('.left-action').style.opacity = Math.min(currentX / 60, 1);
            swipeBg.querySelector('.right-action').style.opacity = 0;
        } else {
            swipeBg.querySelector('.right-action').style.opacity = Math.min(Math.abs(currentX) / 60, 1);
            swipeBg.querySelector('.left-action').style.opacity = 0;
        }
    };
    const endDrag = async () => {
        if (!isDragging) return;
        isDragging = false;
        taskItemEl.style.transition = 'transform 0.2s ease-out';
        if (Math.abs(currentX) > 80) {
            const dir = currentX > 0 ? 1 : -1;
            taskItemEl.style.transform = `translateX(${dir * window.innerWidth}px)`;
            setTimeout(async () => {
                if(confirm('本当に削除しますか？')) {
                    await deleteTask(task.id);
                    loadTasks();
                    if (document.getElementById('view-calendar').classList.contains('active')) renderCalendar(selectedDateStr);
                } else {
                    taskItemEl.style.transform = 'translateX(0)';
                }
            }, 250);
        } else {
            taskItemEl.style.transform = 'translateX(0)';
        }
    };
    taskItemEl.addEventListener('touchstart', startDrag, {passive: true});
    taskItemEl.addEventListener('touchmove', moveDrag, {passive: true});
    taskItemEl.addEventListener('touchend', endDrag);
    taskItemEl.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', moveDrag);
    window.addEventListener('mouseup', endDrag);

    taskItemEl.addEventListener('click', (e) => {
        if (Math.abs(lastMoveX) > 10) { e.preventDefault(); return; }
        if (e.target.closest('input') || e.target.closest('a')) return;
        openModal(task);
    });
}

function renderTasks() {
    const list = document.getElementById('task-list');
    list.innerHTML = '';
    
    let filtered = [...currentTasks];
    const search = document.getElementById('search-input').value.toLowerCase();
    const status = document.getElementById('filter-status').value;
    const sort = document.getElementById('sort-select').value;

    if(search) filtered = filtered.filter(t => t.title.toLowerCase().includes(search));
    if(status === 'active') filtered = filtered.filter(t => !t.completed);
    if(status === 'completed') filtered = filtered.filter(t => t.completed);

    filtered.sort((a, b) => {
        if(sort === 'deadline') return (a.deadline || '9999-99-99').localeCompare(b.deadline || '9999-99-99');
        if(sort === 'priority') return b.priority - a.priority;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });

    if(filtered.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
    } else {
        document.getElementById('empty-state').classList.add('hidden');
        filtered.forEach(task => {
            const li = document.createElement('li');
            li.className = `task-item-wrapper ${task.completed ? 'completed' : ''}`;
            const priorityIcon = task.priority == 3 ? '🔥高' : (task.priority == 2 ? '⭐中' : '🌱低');
            
            li.innerHTML = `
                <div class="task-swipe-bg">
                    <span class="left-action">🗑️ 削除</span>
                    <span class="right-action">🗑️ 削除</span>
                </div>
                <div class="task-item">
                    <div class="task-header">
                        <input type="checkbox" class="task-chk" ${task.completed ? 'checked' : ''}>
                        <div class="task-content">
                            <input type="text" class="inline-edit-title" value="${task.title}">
                            <div class="task-meta">
                                <span class="inline-date-wrapper">📅 <input type="datetime-local" class="inline-edit-date" value="${task.deadline || ''}"></span>
                                <span class="inline-date-wrapper">${priorityIcon}</span>
                            </div>
                        </div>
                    </div>
                </div>`;
            
            const taskItemEl = li.querySelector('.task-item');
            
            taskItemEl.querySelector('.inline-edit-title').addEventListener('change', async e => { task.title = e.target.value; await saveTask(task); });
            taskItemEl.querySelector('.inline-edit-date').addEventListener('change', async e => { task.deadline = e.target.value; task.deadlineAt = e.target.value ? new Date(e.target.value).toISOString() : ''; await saveTask(task); loadTasks(); });
            taskItemEl.querySelector('.task-chk').addEventListener('change', async (e) => { await toggleTaskStatus(task); loadTasks(); });

            applySwipeToDelete(li, taskItemEl, task);
            list.appendChild(li);
        });
    }
}

function isTaskOnDate(task, dateStr) {
    if (task.completed) return false;
    if (task.startDate && task.deadline) {
        const startDay = task.startDate.split('T')[0];
        const endDay = task.deadline.split('T')[0];
        if (dateStr >= startDay && dateStr <= endDay) return true;
    } else if (task.deadline && task.deadline.startsWith(dateStr)) return true;
    if (task.extraDates && task.extraDates.includes(dateStr)) return true;
    return false;
}

function renderCalendar(restoreSelectedDate = null) {
    if (!restoreSelectedDate) selectedDateStr = null;
    document.getElementById('cal-month').innerText = `${calDate.getFullYear()}年 ${calDate.getMonth()+1}月`;
    document.getElementById('cal-prev').onclick = () => { calDate.setMonth(calDate.getMonth()-1); renderCalendar(); };
    document.getElementById('cal-next').onclick = () => { calDate.setMonth(calDate.getMonth()+1); renderCalendar(); };
    
    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';
    const daysInMonth = new Date(calDate.getFullYear(), calDate.getMonth()+1, 0).getDate();
    
    ['日','月','火','水','木','金','土'].forEach(wd => {
        const div = document.createElement('div'); div.style.fontWeight = 'bold'; div.style.color = 'var(--text-secondary)'; div.style.padding = '8px 0'; div.innerText = wd; grid.appendChild(div);
    });

    const firstDay = new Date(calDate.getFullYear(), calDate.getMonth(), 1).getDay();
    for(let i=0; i<firstDay; i++) { grid.appendChild(document.createElement('div')); }

    for(let i=1; i<=daysInMonth; i++) {
        const dateStr = `${calDate.getFullYear()}-${String(calDate.getMonth()+1).padStart(2,'0')}-${String(i).padStart(2,'0')}`;
        const hasTask = currentTasks.some(t => isTaskOnDate(t, dateStr));
        const div = document.createElement('div');
        div.className = `cal-day ${hasTask ? 'has-task' : ''}`;
        if (dateStr === selectedDateStr) div.classList.add('selected-day');
        div.innerText = i;
        
        div.onclick = () => {
            if (selectedDateStr === dateStr) { openModal(null, dateStr); return; }
            document.querySelectorAll('.cal-day').forEach(el => el.classList.remove('selected-day'));
            div.classList.add('selected-day');
            selectedDateStr = dateStr;

            const dayTasks = currentTasks.filter(t => isTaskOnDate(t, dateStr));
            let taskHtml = dayTasks.length === 0 ? '<p style="color:var(--text-secondary)">タスクはありません</p>' : dayTasks.map(t => {
                const timePart = (t.deadline && t.deadline.startsWith(dateStr) && t.deadline.includes('T')) ? t.deadline.split('T')[1] : '';
                return `
                <div class="task-item-wrapper cal-task-wrapper" data-task-id="${t.id}" style="margin-bottom:8px;">
                    <div class="task-swipe-bg" style="border-radius: 8px;">
                        <span class="left-action">🗑️ 削除</span>
                        <span class="right-action">🗑️ 削除</span>
                    </div>
                    <div class="task-item" style="display:flex; flex-direction:column; align-items:flex-start;">
                        <div style="font-weight:600; width:100%; pointer-events:none;">${t.completed?'✓ ':'🟢 '}${t.title} <span style="font-size: 0.8em; color: var(--text-secondary); font-weight:normal;">${timePart}</span></div>
                    </div>
                </div>`;
            }).join('');
            
            taskHtml += `<button class="btn-outline full-width" style="margin-top:16px;" onclick="openModal(null, '${dateStr}')">＋ ${calDate.getMonth()+1}月${i}日にタスクを追加</button>`;
            const container = document.getElementById('calendar-tasks');
            container.innerHTML = `<h3>${calDate.getMonth()+1}月${i}日の予定</h3><br>` + taskHtml;
            
            container.querySelectorAll('.cal-task-wrapper').forEach(wrapperEl => {
                const task = currentTasks.find(t => t.id === wrapperEl.getAttribute('data-task-id'));
                const taskItemEl = wrapperEl.querySelector('.task-item');
                if(task && taskItemEl) applySwipeToDelete(wrapperEl, taskItemEl, task);
            });
        };
        grid.appendChild(div);
        if (dateStr === restoreSelectedDate) div.onclick();
    }
}

function updateStats() {
    const completed = currentTasks.filter(t => t.completed).length;
    const total = currentTasks.length;
    const active = total - completed;
    const rate = total === 0 ? 0 : Math.round((completed/total)*100);
    
    document.getElementById('stat-active').innerText = active;
    document.getElementById('stat-completed').innerText = completed;
    document.getElementById('stat-rate').innerText = `${rate}%`;
    document.getElementById('stat-progress').style.width = `${rate}%`;
}
