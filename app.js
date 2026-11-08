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
        console.error('Error fetching metadata:', e);
        return { title: '', description: '', image: '' };
    }
}

// --- Database Module ---
const DB_NAME = 'TaskFlowDB';
const DB_VERSION = 1;
let dbInstance = null;

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
        request.onsuccess = (e) => {
            dbInstance = e.target.result;
            resolve(dbInstance);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}
function getDB() { return dbInstance; }

function generateId() { return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9); }

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

function saveTask(task) {
    const db = getDB();
    if(!task.id) task.id = generateId();
    if(!task.createdAt) task.createdAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').put(task);
        tx.oncomplete = () => resolve(task);
        tx.onerror = (e) => reject(e);
    });
}

function getAllTasks() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readonly');
        const req = tx.objectStore('tasks').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e);
    });
}

function deleteTask(id) {
    const db = getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').delete(id);
        tx.oncomplete = () => resolve();
    });
}

async function toggleTaskStatus(task) {
    task.completed = !task.completed;
    if(task.completed && task.recurring !== 'none') {
        let newDateStr;
        let newStartStr = null;
        const weekdayMap = { 'sun':0, 'mon':1, 'tue':2, 'wed':3, 'thu':4, 'fri':5, 'sat':6 };
        
        if(task.recurring === 'daily') {
            newDateStr = calculateDate(task.deadline, 'days', 1);
            if(task.startDate) newStartStr = calculateDate(task.startDate, 'days', 1);
        } else if(task.recurring === 'weekly') {
            newDateStr = calculateDate(task.deadline, 'days', 7);
            if(task.startDate) newStartStr = calculateDate(task.startDate, 'days', 7);
        } else if(task.recurring === 'monthly') {
            newDateStr = calculateDate(task.deadline, 'months', 1);
            if(task.startDate) newStartStr = calculateDate(task.startDate, 'months', 1);
        } else if(task.recurring in weekdayMap) {
            let d = task.deadline ? new Date(task.deadline) : new Date();
            d.setDate(d.getDate() + 1); 
            while(d.getDay() !== weekdayMap[task.recurring]) {
                d.setDate(d.getDate() + 1);
            }
            const tzOffset = d.getTimezoneOffset() * 60000;
            newDateStr = (new Date(d - tzOffset)).toISOString().slice(0, 16);
            if(task.startDate && task.deadline) {
                const diffTime = Math.abs(new Date(newDateStr) - new Date(task.deadline));
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                newStartStr = calculateDate(task.startDate, 'days', diffDays);
            }
        }
        
        const nextTask = { 
            ...task, id: generateId(), completed: false, 
            deadline: newDateStr, startDate: newStartStr,
            notified: false, subtasks: task.subtasks.map(st => ({...st, completed: false})) 
        };
        await saveTask(nextTask);
    }
    return saveTask(task);
}

// --- PWA Update Module ---
let newWorker;
function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        showUpdateBanner();
                    }
                });
            });
        }).catch(e => console.log('SW Registration error', e));

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                refreshing = true;
                window.location.reload();
            }
        });
    }
}

function showUpdateBanner() {
    const banner = document.getElementById('update-banner');
    if (banner) {
        banner.style.display = 'flex';
        const btn = document.getElementById('btn-update');
        if (btn) btn.disabled = false;
    }
}

function applyUpdate() {
    const banner = document.getElementById('update-banner');
    if (banner) banner.style.display = 'none';
    if (newWorker) {
        newWorker.postMessage({ action: 'skipWaiting' });
    } else {
        window.location.reload(true);
    }
}

async function checkForUpdateManual() {
    const btn = document.getElementById('btn-manual-update');
    const originalText = btn.innerText;
    btn.innerText = '🔄 確認中...';
    btn.disabled = true;

    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            await reg.update(); 
            if (reg.installing || reg.waiting) {
                alert('新しいバージョンが見つかりました！\n画面上部のバナーから「更新」を押してください。');
                showUpdateBanner();
            } else {
                alert('現在、最新バージョンをご利用中です。');
            }
        } else {
            alert('この環境では更新機能を利用できません。');
        }
    } catch (e) {
        alert('更新の確認に失敗しました。ネットワーク状況を確認してください。');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

function fetchAppVersion() {
    fetch('sw.js', {cache: "no-store"})
        .then(res => res.text())
        .then(text => {
            const match = text.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
            if (match && match[1]) {
                document.getElementById('app-version-info').innerText = `現在のバージョン: ${match[1].replace('taskflow-cache-', '')}`;
            }
        }).catch(() => {});
}

// --- Application Logic ---
let currentTasks = [];
let calDate = new Date();
let selectedDateStr = null;
let currentExtraDates = []; 
let currentStatStatus = null; 

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        setupUI();
        await loadTasks();
        setupServiceWorker();
        fetchAppVersion();
    } catch(err) {
        alert("データベースエラー");
    }
});

function setupUI() {
    const btnUpdate = document.getElementById('btn-update');
    const btnDismiss = document.getElementById('btn-update-dismiss');
    if(btnUpdate) btnUpdate.addEventListener('click', applyUpdate);
    if(btnDismiss) btnDismiss.addEventListener('click', () => {
        document.getElementById('update-banner').style.display = 'none';
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

    document.getElementById('card-stat-active').addEventListener('click', () => toggleStatDetails('active'));
    document.getElementById('card-stat-completed').addEventListener('click', () => toggleStatDetails('completed'));
    document.getElementById('stat-group-by').addEventListener('change', () => { if(currentStatStatus) renderStatDetails(); });

    document.getElementById('fab-add').addEventListener('click', () => {
        const viewCal = document.getElementById('view-calendar');
        if (viewCal.classList.contains('active') && selectedDateStr) {
            openModal(null, selectedDateStr);
        } else {
            openModal();
        }
    });
    
    function closeModal() {
        const modal = document.getElementById('task-modal');
        modal.classList.add('hidden');
    }
    
    document.getElementById('btn-cancel').addEventListener('click', closeModal);
    document.getElementById('modal-overlay').addEventListener('click', closeModal);

    document.getElementById('btn-add-subtask').addEventListener('click', () => {
        const container = document.getElementById('subtasks-container');
        const div = document.createElement('div');
        div.className = 'subtask-item';
        div.innerHTML = `<input type="text" placeholder="サブタスクを入力..." data-id="${generateId()}" class="st-input"><button type="button" class="btn-st-del">×</button>`;
        div.querySelector('.btn-st-del').onclick = () => div.remove();
        container.appendChild(div);
    });

    document.getElementById('btn-add-url').addEventListener('click', () => addUrlField());
    document.getElementById('btn-add-image').addEventListener('click', () => addImageField());

    document.getElementById('btn-add-extra-date').addEventListener('click', () => {
        const input = document.getElementById('extra-date-input');
        if (input.value && !currentExtraDates.includes(input.value)) {
            currentExtraDates.push(input.value);
            renderExtraDates();
            input.value = '';
        }
    });

    document.getElementById('btn-save').addEventListener('click', async () => {
        const title = document.getElementById('task-title').value;
        if(!title) return alert('タスク名を入力してください');
        
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
            title, startDate: document.getElementById('task-start').value,
            deadline: document.getElementById('task-deadline').value,
            extraDates: currentExtraDates, priority: document.getElementById('task-priority').value,
            recurring: document.getElementById('task-recurring').value, urls, images,
            memo: document.getElementById('task-memo').value,
            completed: document.getElementById('task-id').dataset.completed === 'true',
            subtasks, url: '', image: ''
        };

        await saveTask(task);
        closeModal();
        loadTasks();
        if (document.getElementById('view-calendar').classList.contains('active')) renderCalendar(selectedDateStr);
    });

    document.getElementById('search-input').addEventListener('input', renderTasks);
    document.getElementById('filter-status').addEventListener('change', renderTasks);
    document.getElementById('sort-select').addEventListener('change', renderTasks);
    document.getElementById('btn-manual-update').addEventListener('click', checkForUpdateManual);

    const btnRequestNotify = document.getElementById('btn-request-notify');
    if (btnRequestNotify) {
        btnRequestNotify.addEventListener('click', async () => {
            if (!("Notification" in window)) {
                alert("このブラウザ・端末は通知機能をサポートしていません。iOSの場合は「ホーム画面に追加」から起動してください。");
                return;
            }
            try {
                let permission = Notification.permission;
                if (permission === "granted") {
                    alert("既に通知は許可されています。");
                } else if (permission !== "denied") {
                    permission = await Notification.requestPermission();
                    if (permission === "granted") {
                        alert("通知が許可されました！");
                    } else {
                        alert("通知の許可が拒否されました。");
                    }
                } else {
                    alert("通知がブロックされています。端末の設定から許可してください。");
                }
            } catch (e) {
                alert("通知設定の呼び出しに失敗しました。");
            }
        });
    }

    const btnBackup = document.getElementById('btn-backup');
    if (btnBackup) {
        btnBackup.addEventListener('click', async () => {
            try {
                const tasks = await getAllTasks();
                if (tasks.length === 0) {
                    alert("バックアップするタスクデータがありません。");
                    return;
                }
                const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `taskflow_backup_${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 100);
            } catch (e) {
                alert('バックアップの作成に失敗しました。');
            }
        });
    }

    const inputRestore = document.getElementById('input-restore');
    if (inputRestore) {
        inputRestore.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (evt) => {
                try {
                    const tasks = JSON.parse(evt.target.result);
                    if (!Array.isArray(tasks)) throw new Error('Invalid format');
                    if (confirm(`読み込んだ ${tasks.length} 件のデータで復元しますか？\n※現在のデータは完全に上書き消去されます。`)) {
                        const db = getDB();
                        const tx = db.transaction('tasks', 'readwrite');
                        tx.objectStore('tasks').clear();
                        await new Promise((resolve, reject) => {
                            tx.oncomplete = resolve;
                            tx.onerror = reject;
                        });
                        for (const task of tasks) {
                            await saveTask(task);
                        }
                        alert('データの復元が完了しました。');
                        loadTasks();
                        if (document.getElementById('view-stats').classList.contains('active')) updateStats();
                    }
                } catch (err) {
                    alert('ファイルの読み込みに失敗しました。正しいJSONファイルを選択してください。');
                }
                e.target.value = '';
            };
            reader.readAsText(file);
        });
    }

    const btnClearAll = document.getElementById('btn-clear-all');
    if (btnClearAll) {
        btnClearAll.addEventListener('click', async () => {
            if (confirm('⚠️ 本当にすべてのデータを消去しますか？この操作は取り消せません。')) {
                try {
                    const db = getDB();
                    const tx = db.transaction('tasks', 'readwrite');
                    tx.objectStore('tasks').clear();
                    tx.oncomplete = () => {
                        alert('全データを消去しました。');
                        loadTasks();
                        if (document.getElementById('view-stats').classList.contains('active')) updateStats();
                    };
                } catch (e) {
                    alert('データの消去に失敗しました。');
                }
            }
        });
    }
}

// 強化版スワイプ削除ロジック（タッチとマウス両対応）
function applySwipeToDelete(wrapperEl, taskItemEl, task) {
    let startX = 0, currentX = 0, isDragging = false, lastMoveX = 0;

    const startDrag = (e) => {
        if (e.target.closest('input') || e.target.closest('button') || e.target.closest('a') || e.target.closest('select')) return;
        if (e.type === 'mousedown' && e.button !== 0) return;
        
        startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        currentX = 0;
        lastMoveX = 0;
        isDragging = true;
        taskItemEl.style.transition = 'none';
    };

    const moveDrag = (e) => {
        if (!isDragging) return;
        const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        currentX = clientX - startX;
        
        // 縦方向のスクロールを優先させたい場合は横スワイプ判定を厳密にする必要があるが、
        // 今回はtouch-action: pan-y でブラウザに任せている。
        if (Math.abs(currentX) > 10 && e.cancelable) {
             // 横スワイプが明確な場合はデフォルト動作(スクロール)を止める
            // e.preventDefault();
        }

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

    const endDrag = async (e) => {
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

    // タッチイベント
    taskItemEl.addEventListener('touchstart', startDrag, {passive: true});
    taskItemEl.addEventListener('touchmove', moveDrag, {passive: true});
    taskItemEl.addEventListener('touchend', endDrag);
    taskItemEl.addEventListener('touchcancel', endDrag);

    // マウスイベント
    taskItemEl.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', moveDrag);
    window.addEventListener('mouseup', endDrag);

    // タップで詳細を開く
    taskItemEl.addEventListener('click', (e) => {
        // 大きくスワイプした後のクリック（誤爆）は無視
        if (Math.abs(lastMoveX) > 10) {
            e.preventDefault();
            return;
        }
        // チェックボックスや入力欄などを触った場合はモーダルを開かない
        if (e.target.closest('input') || e.target.closest('button') || e.target.closest('a') || e.target.closest('img')) return;
        
        openModal(task);
    });
}

function addUrlField(name = '', url = '', description = '', image = '') {
    const container = document.getElementById('urls-container');
    const div = document.createElement('div');
    div.className = 'multi-item url-input-item';
    div.innerHTML = `<button type="button" class="btn-remove-item" title="削除">×</button>
        <div class="multi-item-row"><span style="font-size: 12px; width: 40px;">URL</span><input type="url" class="url-val" placeholder="https://..." value="${url}"></div>
        <div class="multi-item-row"><span style="font-size: 12px; width: 40px;"></span><button type="button" class="btn-fetch-meta btn-secondary" style="font-size:11px; padding:4px 8px; border-radius:4px;">ページ情報を自動取得</button></div>
        <div class="multi-item-row"><span style="font-size: 12px; width: 40px;">名前</span><input type="text" class="url-name" placeholder="リンクの名前（空なら自動取得）" value="${name}"></div>
        <input type="hidden" class="url-desc" value="${description}">
        <input type="hidden" class="url-img" value="${image}">
        <div class="url-preview-card" style="${(name || image || description) ? 'display:flex;' : 'display:none;'} margin-top:8px; border:1px solid var(--border-color); border-radius:8px; overflow:hidden; font-size:12px; background:var(--bg-color);">
            ${image ? `<img src="${image}" style="width:60px; height:60px; object-fit:cover; flex-shrink:0;">` : ''}
            <div style="padding:8px; display:flex; flex-direction:column; justify-content:center; overflow:hidden; flex:1;">
                <div class="preview-title" style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name || url || 'プレビュー未取得'}</div>
                ${description ? `<div class="preview-desc" style="color:var(--text-secondary); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${description}</div>` : ''}
            </div>
        </div>`;
        
    div.querySelector('.btn-remove-item').onclick = () => div.remove();
    
    div.querySelector('.btn-fetch-meta').onclick = async () => {
        const urlVal = div.querySelector('.url-val').value;
        if (!urlVal) return alert('URLを入力してください');
        
        const btn = div.querySelector('.btn-fetch-meta');
        const originalText = btn.innerText;
        btn.innerText = '取得中...';
        btn.disabled = true;
        
        const meta = await fetchUrlMetadata(urlVal);
        
        btn.innerText = originalText;
        btn.disabled = false;
        
        const nameInput = div.querySelector('.url-name');
        if (!nameInput.value && meta.title) {
            nameInput.value = meta.title;
        }
        
        div.querySelector('.url-desc').value = meta.description;
        div.querySelector('.url-img').value = meta.image;
        
        const card = div.querySelector('.url-preview-card');
        card.style.display = 'flex';
        const currentName = nameInput.value || meta.title || urlVal;
        card.innerHTML = `
            ${meta.image ? `<img src="${meta.image}" style="width:60px; height:60px; object-fit:cover; flex-shrink:0;">` : ''}
            <div style="padding:8px; display:flex; flex-direction:column; justify-content:center; overflow:hidden; flex:1;">
                <div class="preview-title" style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${currentName}</div>
                ${meta.description ? `<div class="preview-desc" style="color:var(--text-secondary); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${meta.description}</div>` : ''}
            </div>
        `;
    };
    
    container.appendChild(div);
}

function addImageField(name = '', data = '') {
    const container = document.getElementById('images-container');
    const div = document.createElement('div');
    div.className = 'multi-item img-input-item';
    div.innerHTML = `<button type="button" class="btn-remove-item" title="削除">×</button>
        <div class="multi-item-row"><span style="font-size: 12px; width: 40px;">名前</span><input type="text" class="img-name" placeholder="画像の名前" value="${name}"></div>
        <div class="multi-item-row"><input type="file" class="img-file" accept="image/*" style="font-size: 12px;"><input type="hidden" class="img-data" value="${data}"></div>
        <img class="attachment-preview img-preview" style="display:${data ? 'block' : 'none'};" src="${data}">`;
    div.querySelector('.btn-remove-item').onclick = () => div.remove();
    div.querySelector('.img-file').addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = evt => {
                const dataUrl = evt.target.result;
                div.querySelector('.img-data').value = dataUrl;
                div.querySelector('.img-preview').src = dataUrl;
                div.querySelector('.img-preview').style.display = 'block';
            };
            reader.readAsDataURL(file);
        }
    });
    container.appendChild(div);
}

function renderExtraDates() {
    const container = document.getElementById('extra-dates-container');
    container.innerHTML = '';
    currentExtraDates.sort(); 
    currentExtraDates.forEach((dateStr, index) => {
        const div = document.createElement('div');
        div.className = 'extra-date-item';
        div.innerHTML = `<span>${dateStr}</span> <button type="button" class="btn-remove-date" data-index="${index}">×</button>`;
        div.querySelector('.btn-remove-date').onclick = (e) => {
            currentExtraDates.splice(e.target.dataset.index, 1);
            renderExtraDates();
        };
        container.appendChild(div);
    });
}

function openModal(task = null, defaultDateStr = null) {
    document.getElementById('modal-title').innerText = task ? '詳細を編集' : '新しいタスク';
    document.getElementById('task-id').value = task ? task.id : '';
    document.getElementById('task-id').dataset.completed = task ? task.completed : 'false';
    document.getElementById('task-title').value = task ? task.title : '';
    document.getElementById('task-start').value = task && task.startDate ? task.startDate : '';
    
    let defaultDeadline = task ? task.deadline : '';
    if (!defaultDeadline && defaultDateStr) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        defaultDeadline = `${defaultDateStr}T${hh}:${mm}`;
    }
    document.getElementById('task-deadline').value = defaultDeadline;
    
    currentExtraDates = task && task.extraDates ? [...task.extraDates] : [];
    renderExtraDates();
    document.getElementById('extra-date-input').value = '';
    document.getElementById('task-priority').value = task ? task.priority : '2';
    document.getElementById('task-recurring').value = task ? task.recurring : 'none';
    
    document.getElementById('urls-container').innerHTML = '';
    if (task && task.urls) task.urls.forEach(u => addUrlField(u.name, u.url, u.description, u.image));
    else if (task && task.url) addUrlField('リンク', task.url);

    document.getElementById('images-container').innerHTML = '';
    if (task && task.images) task.images.forEach(i => addImageField(i.name, i.data));
    else if (task && task.image) addImageField('画像', task.image);

    document.getElementById('task-memo').value = task ? task.memo : '';
    
    const stContainer = document.getElementById('subtasks-container');
    stContainer.innerHTML = '';
    if(task && task.subtasks) {
        task.subtasks.forEach(st => {
            const div = document.createElement('div');
            div.className = 'subtask-item';
            div.innerHTML = `<input type="checkbox" ${st.completed ? 'checked' : ''} class="task-chk st-chk"><input type="text" value="${st.title}" data-id="${st.id}" data-completed="${st.completed}" class="st-input"><button type="button" class="btn-st-del">×</button>`;
            div.querySelector('.btn-st-del').onclick = () => div.remove();
            div.querySelector('.st-chk').onchange = (e) => { div.querySelector('.st-input').dataset.completed = e.target.checked; };
            stContainer.appendChild(div);
        });
    }
    
    const modal = document.getElementById('task-modal');
    modal.classList.remove('hidden');
}

async function loadTasks() { currentTasks = await getAllTasks(); renderTasks(); }

function renderTasks() {
    const list = document.getElementById('task-list');
    const emptyState = document.getElementById('empty-state');
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

    if(filtered.length === 0) { emptyState.classList.remove('hidden'); } 
    else {
        emptyState.classList.add('hidden');
        filtered.forEach(task => {
            const li = document.createElement('li');
            li.className = `task-item-wrapper ${task.completed ? 'completed' : ''}`;
            
            const priorityIcon = task.priority == 3 ? '🔥高' : (task.priority == 2 ? '⭐中' : '🌱低');
            let extraDatesHtml = task.extraDates && task.extraDates.length > 0 ? `<span class="inline-date-wrapper" style="font-size:11px;">+追加 ${task.extraDates.length}日</span>` : '';
            
            let urlPreviewHtml = (task.urls && task.urls.length > 0) ? `<div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">` + task.urls.map(u => {
                const displayName = u.name || 'リンク';
                if (u.image || u.description) {
                    return `<a href="${u.url}" target="_blank" class="rich-url-preview" onclick="event.stopPropagation()" style="display:flex; text-decoration:none; color:inherit; border:1px solid var(--border-color); border-radius:8px; overflow:hidden; background:var(--bg-color);">
                        ${u.image ? `<img src="${u.image}" style="width:60px; height:60px; object-fit:cover; flex-shrink:0; border-right:1px solid var(--border-color);">` : ''}
                        <div style="padding:8px; display:flex; flex-direction:column; justify-content:center; overflow:hidden; flex:1;">
                            <div style="font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-color);">${displayName}</div>
                            ${u.description ? `<div style="font-size:10px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;">${u.description}</div>` : ''}
                            <div style="font-size:10px; color:#007aff; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${u.url}</div>
                        </div>
                    </a>`;
                } else {
                    return `<a href="${u.url}" target="_blank" class="url-preview" onclick="event.stopPropagation()">🔗 ${displayName}</a>`;
                }
            }).join('') + `</div>` : '';

            let imagePreviewHtml = (task.images && task.images.length > 0) ? `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">` + task.images.map(i => `<div style="display:flex; flex-direction:column; align-items:flex-start;"><span style="font-size:10px; color:var(--text-secondary);">${i.name}</span><img src="${i.data}" class="attachment-preview" onclick="event.stopPropagation()"></div>`).join('') + `</div>` : '';

            const subtasksHtml = task.subtasks && task.subtasks.length > 0 ? `<div class="home-subtasks">${task.subtasks.map((st, idx) => `<label class="home-subtask-item"><input type="checkbox" class="home-st-chk" data-index="${idx}" ${st.completed ? 'checked' : ''}><span class="${st.completed ? 'st-completed' : ''}">${st.title}</span></label>`).join('')}</div>` : '';
            
            const startValue = task.startDate || '';
            const deadlineValue = task.deadline || '';
            let dateHtml = (startValue && deadlineValue) ? `📅 <span style="font-size:12px; color:var(--text-secondary); margin-right:4px;">${startValue.replace('T', ' ')} 〜</span> <input type="datetime-local" class="inline-edit-date" value="${deadlineValue}">` : `📅 <input type="datetime-local" class="inline-edit-date" value="${deadlineValue}">`;

            // 詳細・削除ボタンを廃止し、スワイプ用の背景とコンテンツのみにする
            li.innerHTML = `
                <div class="task-swipe-bg">
                    <span class="left-action">🗑️ 削除</span>
                    <span class="right-action">🗑️ 削除</span>
                </div>
                <div class="task-item">
                    <div class="task-header"><input type="checkbox" class="task-chk" ${task.completed ? 'checked' : ''}>
                        <div class="task-content"><input type="text" class="inline-edit-title" value="${task.title}"><div class="task-meta"><span class="inline-date-wrapper">${dateHtml}</span>${extraDatesHtml}<span class="inline-date-wrapper">${priorityIcon}</span></div>${urlPreviewHtml}${imagePreviewHtml}${subtasksHtml}</div>
                    </div>
                </div>`;
            
            const taskItemEl = li.querySelector('.task-item');
            
            taskItemEl.querySelector('.inline-edit-title').addEventListener('change', async e => { task.title = e.target.value; await saveTask(task); });
            taskItemEl.querySelector('.inline-edit-title').addEventListener('click', e => e.stopPropagation());
            
            taskItemEl.querySelector('.inline-edit-date').addEventListener('change', async e => {
                task.deadline = e.target.value; await saveTask(task);
                if (document.getElementById('sort-select').value === 'deadline') loadTasks();
            });
            taskItemEl.querySelector('.inline-edit-date').addEventListener('click', e => e.stopPropagation());

            taskItemEl.querySelectorAll('.home-st-chk').forEach(chk => {
                chk.addEventListener('change', async (e) => {
                    const idx = e.target.dataset.index;
                    task.subtasks[idx].completed = e.target.checked;
                    await saveTask(task);
                    const span = e.target.nextElementSibling;
                    if(e.target.checked) span.classList.add('st-completed');
                    else span.classList.remove('st-completed');
                });
            });

            taskItemEl.querySelector('.task-chk').addEventListener('change', async (e) => {
                if (e.target.checked && !task.completed) {
                    taskItemEl.classList.add('completing');
                    setTimeout(async () => { await toggleTaskStatus(task); loadTasks(); }, 500);
                } else { await toggleTaskStatus(task); loadTasks(); }
            });

            // スワイプイベント登録
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
                const extraBadge = (t.extraDates && t.extraDates.includes(dateStr)) ? ' <span style="font-size:10px; background:#eee; padding:2px 4px; border-radius:4px;">追加日</span>' : '';
                const startDay = t.startDate ? t.startDate.split('T')[0] : null;
                const endDay = t.deadline ? t.deadline.split('T')[0] : null;
                const rangeBadge = (startDay && endDay && dateStr >= startDay && dateStr <= endDay) ? ' <span style="font-size:10px; background:#e0f7fa; color:#006064; padding:2px 4px; border-radius:4px;">期間中</span>' : '';
                
                let imgHtml = (t.images && t.images.length > 0) ? `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">` + t.images.map(img => `<img src="${img.data}" style="height: 50px; width: 50px; object-fit: cover; border-radius: 6px; cursor: pointer; border: 1px solid var(--border-color);" onclick="event.stopPropagation(); window.open('${img.data}', '_blank');">`).join('') + `</div>` : '';

                let urlHtml = (t.urls && t.urls.length > 0) ? `<div style="display:flex; flex-direction:column; gap:4px; margin-top:8px; width:100%;">` + t.urls.map(u => {
                    const displayName = u.name || 'リンク';
                    if(u.image || u.description) {
                        return `<a href="${u.url}" target="_blank" onclick="event.stopPropagation()" style="display:flex; text-decoration:none; color:inherit; border:1px solid var(--border-color); border-radius:6px; overflow:hidden; background:var(--bg-color); width:100%;">
                            ${u.image ? `<img src="${u.image}" style="width:40px; height:40px; object-fit:cover; flex-shrink:0; border-right:1px solid var(--border-color);">` : ''}
                            <div style="padding:4px 8px; display:flex; flex-direction:column; justify-content:center; overflow:hidden; flex:1;">
                                <div style="font-size:10px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-color);">${displayName}</div>
                                <div style="font-size:9px; color:#007aff; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${u.url}</div>
                            </div>
                        </a>`;
                    } else {
                        return `<a href="${u.url}" target="_blank" class="url-preview" onclick="event.stopPropagation()" style="width:fit-content;">🔗 ${displayName}</a>`;
                    }
                }).join('') + `</div>` : '';

                return `
                <div class="task-item-wrapper cal-task-wrapper" data-task-id="${t.id}" style="margin-bottom:8px;">
                    <div class="task-swipe-bg" style="border-radius: 8px;">
                        <span class="left-action">🗑️ 削除</span>
                        <span class="right-action">🗑️ 削除</span>
                    </div>
                    <div class="task-item" style="display:flex; flex-direction:column; align-items:flex-start;">
                        <div style="font-weight:600; width:100%; pointer-events:none;">${t.completed?'✓ ':'🟢 '}${t.title} <span style="font-size: 0.8em; color: var(--text-secondary); font-weight:normal;">${timePart}</span>${extraBadge}${rangeBadge}</div>
                        ${urlHtml}
                        ${imgHtml}
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

function toggleStatDetails(status) {
    const detailsCard = document.getElementById('stat-details');
    const cardActive = document.getElementById('card-stat-active');
    const cardCompleted = document.getElementById('card-stat-completed');
    
    if (currentStatStatus === status) {
        currentStatStatus = null; detailsCard.classList.add('hidden');
        cardActive.style.borderColor = 'transparent'; cardCompleted.style.borderColor = 'transparent';
        cardActive.style.backgroundColor = 'var(--card-bg)'; cardCompleted.style.backgroundColor = 'var(--card-bg)';
        return;
    }
    
    currentStatStatus = status; detailsCard.classList.remove('hidden');
    if (status === 'active') {
        cardActive.style.borderColor = '#007aff'; cardActive.style.backgroundColor = 'rgba(0, 122, 255, 0.05)';
        cardCompleted.style.borderColor = 'transparent'; cardCompleted.style.backgroundColor = 'var(--card-bg)';
    } else {
        cardCompleted.style.borderColor = '#34c759'; cardCompleted.style.backgroundColor = 'rgba(52, 199, 89, 0.05)';
        cardActive.style.borderColor = 'transparent'; cardActive.style.backgroundColor = 'var(--card-bg)';
    }
    document.getElementById('stat-details-title').innerText = status === 'active' ? '未完了タスクの内訳' : '完了済みタスクの内訳';
    renderStatDetails();
}

function renderStatDetails() {
    const container = document.getElementById('stat-details-content'); container.innerHTML = '';
    const groupBy = document.getElementById('stat-group-by').value;
    const filtered = currentTasks.filter(t => currentStatStatus === 'active' ? !t.completed : t.completed);
    
    if (filtered.length === 0) { container.innerHTML = '<p style="text-align: center; padding: 12px 0;">該当するタスクがありません。</p>'; return; }
    
    const groups = {};
    filtered.forEach(t => {
        let key = groupBy === 'category' ? (t.category ? t.category : '未分類') : (t.deadline ? t.deadline.split('T')[0] : '日付未設定');
        if (!groups[key]) groups[key] = [];
        groups[key].push(t);
    });
    
    const sortedKeys = Object.keys(groups).sort((a, b) => (a === '日付未設定' || a === '未分類') ? 1 : (b === '日付未設定' || b === '未分類' ? -1 : a.localeCompare(b)));
    
    let html = '';
    sortedKeys.forEach(key => {
        html += `<div class="stat-group"><h4 style="margin: 16px 0 8px 0; border-bottom: 1px solid var(--border-color); padding-bottom: 4px; display: flex; justify-content: space-between;"><span>${key === '日付未設定' || key === '未分類' ? key : (groupBy === 'date' ? '📅 ' + key : '📁 ' + key)}</span><span style="font-weight: normal; background: var(--bg-color); padding: 2px 8px; border-radius: 12px; font-size: 11px;">${groups[key].length}件</span></h4><div style="display: flex; flex-direction: column; gap: 8px;">`;
        groups[key].forEach(t => {
            const extraInfo = groupBy === 'date' ? (t.category ? `📁 ${t.category}` : '') : (t.deadline ? `📅 ${t.deadline.replace('T', ' ')}` : '');
            html += `<div style="font-size: 14px; display: flex; flex-direction: column; background: var(--bg-color); padding: 10px 12px; border-radius: 8px; border-left: 3px solid ${t.completed ? '#34c759' : '#007aff'};"><span style="font-weight: 600; ${t.completed ? 'text-decoration: line-through; color: var(--text-secondary);' : ''}">${t.title}</span>${extraInfo ? `<span style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">${extraInfo}</span>` : ''}</div>`;
        });
        html += `</div></div>`;
    });
    container.innerHTML = html;
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
    if (currentStatStatus) renderStatDetails();
}
