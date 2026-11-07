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

function clearAllData() {
    const db = getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').clear();
        tx.oncomplete = () => resolve();
    });
}

async function toggleTaskStatus(task) {
    task.completed = !task.completed;
    if(task.completed && task.recurring !== 'none') {
        let newDateStr;
        const weekdayMap = { 'sun':0, 'mon':1, 'tue':2, 'wed':3, 'thu':4, 'fri':5, 'sat':6 };
        
        if(task.recurring === 'daily') newDateStr = calculateDate(task.deadline, 'days', 1);
        else if(task.recurring === 'weekly') newDateStr = calculateDate(task.deadline, 'days', 7);
        else if(task.recurring === 'monthly') newDateStr = calculateDate(task.deadline, 'months', 1);
        else if(task.recurring in weekdayMap) {
            let d = task.deadline ? new Date(task.deadline) : new Date();
            d.setDate(d.getDate() + 1); 
            while(d.getDay() !== weekdayMap[task.recurring]) {
                d.setDate(d.getDate() + 1);
            }
            const tzOffset = d.getTimezoneOffset() * 60000;
            newDateStr = (new Date(d - tzOffset)).toISOString().slice(0, 16);
        }
        
        const nextTask = { 
            ...task, 
            id: generateId(), 
            completed: false, 
            deadline: newDateStr, 
            notified: false, 
            subtasks: task.subtasks.map(st => ({...st, completed: false})) 
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
            console.log('SW Registered');
            
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
    
    const btn = document.getElementById('btn-update');
    if (btn) btn.disabled = true;

    if (newWorker) {
        newWorker.postMessage({ action: 'skipWaiting' });
        setTimeout(() => { window.location.reload(); }, 1500);
    } else {
        window.location.reload();
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
        console.error('Update check error', e);
        alert('更新の確認に失敗しました。ネットワーク状況を確認してください。');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

function fetchAppVersion() {
    fetch('sw.js')
        .then(res => res.text())
        .then(text => {
            const match = text.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
            if (match && match[1]) {
                document.getElementById('app-version-info').innerText = `現在のバージョン: ${match[1].replace('taskflow-cache-', '')}`;
            } else {
                document.getElementById('app-version-info').innerText = 'バージョン情報が取得できません';
            }
        })
        .catch(() => {
            document.getElementById('app-version-info').innerText = 'オフライン (バージョン不明)';
        });
}


// --- Application Logic ---
let currentTasks = [];
let calDate = new Date();
let selectedDateStr = null;
let currentExtraDates = []; // 追加日程を一時保持する配列
let currentStatStatus = null; // 'active' or 'completed'

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        setupUI();
        await loadTasks();
        setupServiceWorker();
        fetchAppVersion();
    } catch(err) {
        alert("データベースの初期化に失敗しました。");
        console.error(err);
    }
});

function setupUI() {
    const btnUpdate = document.getElementById('btn-update');
    const btnDismiss = document.getElementById('btn-update-dismiss');
    const banner = document.getElementById('update-banner');
    if(btnUpdate) btnUpdate.addEventListener('click', applyUpdate);
    if(btnDismiss) btnDismiss.addEventListener('click', () => {
        if(banner) banner.style.display = 'none';
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

    // 統計タブのインタラクション
    document.getElementById('card-stat-active').addEventListener('click', () => toggleStatDetails('active'));
    document.getElementById('card-stat-completed').addEventListener('click', () => toggleStatDetails('completed'));
    document.getElementById('stat-group-by').addEventListener('change', () => {
        if(currentStatStatus) renderStatDetails();
    });

    const modal = document.getElementById('task-modal');
    document.getElementById('fab-add').addEventListener('click', () => {
        const viewCal = document.getElementById('view-calendar');
        if (viewCal.classList.contains('active') && selectedDateStr) {
            openModal(null, selectedDateStr);
        } else {
            openModal();
        }
    });
    
    document.getElementById('btn-cancel').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('modal-overlay').addEventListener('click', () => modal.classList.add('hidden'));

    // サブタスク追加
    document.getElementById('btn-add-subtask').addEventListener('click', () => {
        const container = document.getElementById('subtasks-container');
        const id = generateId();
        const div = document.createElement('div');
        div.className = 'subtask-item';
        div.innerHTML = `<input type="text" placeholder="サブタスクを入力..." data-id="${id}" class="st-input"><button type="button" class="btn-st-del">×</button>`;
        div.querySelector('.btn-st-del').onclick = () => div.remove();
        container.appendChild(div);
    });

    // 追加日程の処理
    document.getElementById('btn-add-extra-date').addEventListener('click', () => {
        const input = document.getElementById('extra-date-input');
        if (input.value && !currentExtraDates.includes(input.value)) {
            currentExtraDates.push(input.value);
            renderExtraDates();
            input.value = '';
        }
    });

    // 画像ファイルのプレビュー処理
    document.getElementById('task-image').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(e) {
                const dataUrl = e.target.result;
                document.getElementById('task-image-data').value = dataUrl;
                document.getElementById('task-image-preview').src = dataUrl;
                document.getElementById('task-image-preview').style.display = 'block';
                document.getElementById('btn-clear-image').style.display = 'inline-block';
            };
            reader.readAsDataURL(file);
        }
    });

    document.getElementById('btn-clear-image').addEventListener('click', () => {
        document.getElementById('task-image').value = '';
        document.getElementById('task-image-data').value = '';
        document.getElementById('task-image-preview').src = '';
        document.getElementById('task-image-preview').style.display = 'none';
        document.getElementById('btn-clear-image').style.display = 'none';
    });

    document.getElementById('btn-save').addEventListener('click', async () => {
        const title = document.getElementById('task-title').value;
        if(!title) return alert('タスク名を入力してください');
        
        const subtasks = Array.from(document.querySelectorAll('.st-input')).map(input => ({
            id: input.dataset.id, title: input.value, completed: input.dataset.completed === 'true'
        })).filter(st => st.title.trim() !== '');

        const task = {
            id: document.getElementById('task-id').value || null,
            title,
            deadline: document.getElementById('task-deadline').value,
            extraDates: currentExtraDates,
            priority: document.getElementById('task-priority').value,
            recurring: document.getElementById('task-recurring').value,
            url: document.getElementById('task-url').value,
            image: document.getElementById('task-image-data').value,
            memo: document.getElementById('task-memo').value,
            completed: document.getElementById('task-id').dataset.completed === 'true',
            subtasks
        };
        await saveTask(task);
        
        modal.classList.add('hidden');
        loadTasks();
        
        if (document.getElementById('view-calendar').classList.contains('active')) {
            renderCalendar(selectedDateStr);
        }
    });

    document.getElementById('search-input').addEventListener('input', renderTasks);
    document.getElementById('filter-status').addEventListener('change', renderTasks);
    document.getElementById('sort-select').addEventListener('change', renderTasks);
    document.getElementById('btn-manual-update').addEventListener('click', checkForUpdateManual);
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
    
    document.getElementById('task-url').value = task && task.url ? task.url : '';
    
    const imgData = task && task.image ? task.image : '';
    document.getElementById('task-image-data').value = imgData;
    document.getElementById('task-image').value = ''; 
    if (imgData) {
        document.getElementById('task-image-preview').src = imgData;
        document.getElementById('task-image-preview').style.display = 'block';
        document.getElementById('btn-clear-image').style.display = 'inline-block';
    } else {
        document.getElementById('task-image-preview').src = '';
        document.getElementById('task-image-preview').style.display = 'none';
        document.getElementById('btn-clear-image').style.display = 'none';
    }

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
    document.getElementById('task-modal').classList.remove('hidden');
}

async function loadTasks() {
    currentTasks = await getAllTasks();
    renderTasks();
}

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

    if(filtered.length === 0) {
        emptyState.classList.remove('hidden');
    } else {
        emptyState.classList.add('hidden');
        filtered.forEach(task => {
            const li = document.createElement('li');
            li.className = `task-item ${task.completed ? 'completed' : ''}`;
            
            const priorityIcon = task.priority == 3 ? '🔥高' : (task.priority == 2 ? '⭐中' : '🌱低');
            
            let extraDatesHtml = '';
            if (task.extraDates && task.extraDates.length > 0) {
                extraDatesHtml = `<span class="inline-date-wrapper" style="font-size:11px;">+追加 ${task.extraDates.length}日</span>`;
            }

            let urlPreviewHtml = '';
            if (task.url) {
                urlPreviewHtml = `<a href="${task.url}" target="_blank" class="url-preview" onclick="event.stopPropagation()">🔗 ${task.url}</a>`;
            }

            let imagePreviewHtml = '';
            if (task.image) {
                imagePreviewHtml = `<img src="${task.image}" class="attachment-preview" alt="添付画像" onclick="event.stopPropagation()">`;
            }

            const subtasksHtml = task.subtasks && task.subtasks.length > 0 ? `
                <div class="home-subtasks">
                    ${task.subtasks.map((st, idx) => `
                        <label class="home-subtask-item">
                            <input type="checkbox" class="home-st-chk" data-index="${idx}" ${st.completed ? 'checked' : ''}>
                            <span class="${st.completed ? 'st-completed' : ''}">${st.title}</span>
                        </label>
                    `).join('')}
                </div>
            ` : '';
            
            const deadlineValue = task.deadline || '';

            li.innerHTML = `
                <div class="task-header">
                    <input type="checkbox" class="task-chk" ${task.completed ? 'checked' : ''}>
                    <div class="task-content">
                        <input type="text" class="inline-edit-title" value="${task.title}" placeholder="タスク名">
                        <div class="task-meta">
                            <span class="inline-date-wrapper">
                                📅 <input type="datetime-local" class="inline-edit-date" value="${deadlineValue}">
                            </span>
                            ${extraDatesHtml}
                            <span class="inline-date-wrapper">${priorityIcon}</span>
                        </div>
                        ${urlPreviewHtml}
                        ${imagePreviewHtml}
                        ${subtasksHtml}
                    </div>
                </div>
                <div class="task-actions">
                    <button class="btn-text btn-edit">詳細</button>
                    <button class="btn-text danger btn-del">削除</button>
                </div>
            `;
            
            const titleInput = li.querySelector('.inline-edit-title');
            titleInput.addEventListener('change', async (e) => {
                task.title = e.target.value;
                await saveTask(task);
            });
            titleInput.addEventListener('click', e => e.stopPropagation());
            
            const dateInput = li.querySelector('.inline-edit-date');
            dateInput.addEventListener('change', async (e) => {
                task.deadline = e.target.value;
                await saveTask(task);
                if (document.getElementById('sort-select').value === 'deadline') {
                    loadTasks();
                }
            });
            dateInput.addEventListener('click', e => e.stopPropagation());

            li.querySelectorAll('.home-st-chk').forEach(chk => {
                chk.addEventListener('change', async (e) => {
                    const idx = e.target.dataset.index;
                    task.subtasks[idx].completed = e.target.checked;
                    await saveTask(task);
                    
                    const span = e.target.nextElementSibling;
                    if(e.target.checked) span.classList.add('st-completed');
                    else span.classList.remove('st-completed');
                });
            });

            const mainChk = li.querySelector('.task-chk');
            mainChk.addEventListener('change', async (e) => {
                if (e.target.checked && !task.completed) {
                    li.classList.add('completing');
                    setTimeout(async () => {
                        await toggleTaskStatus(task);
                        loadTasks();
                    }, 500);
                } else {
                    await toggleTaskStatus(task);
                    loadTasks();
                }
            });

            li.querySelector('.btn-edit').addEventListener('click', () => openModal(task));
            li.querySelector('.btn-del').addEventListener('click', async () => {
                if(confirm('本当に削除しますか？')) { await deleteTask(task.id); loadTasks(); }
            });
            list.appendChild(li);
        });
    }
}

function isTaskOnDate(task, dateStr) {
    if (task.completed) return false;
    
    if (task.deadline && task.deadline.startsWith(dateStr)) {
        return true;
    }
    
    if (task.extraDates && task.extraDates.includes(dateStr)) {
        return true;
    }

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
    
    const weekdays = ['日','月','火','水','木','金','土'];
    weekdays.forEach(wd => {
        const div = document.createElement('div');
        div.style.fontWeight = 'bold';
        div.style.color = 'var(--text-secondary)';
        div.style.padding = '8px 0';
        div.innerText = wd;
        grid.appendChild(div);
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
            if (selectedDateStr === dateStr) {
                openModal(null, dateStr);
                return;
            }
            document.querySelectorAll('.cal-day').forEach(el => el.classList.remove('selected-day'));
            div.classList.add('selected-day');
            selectedDateStr = dateStr;

            const dayTasks = currentTasks.filter(t => isTaskOnDate(t, dateStr));
            let taskHtml = dayTasks.length === 0 
                ? '<p style="color:var(--text-secondary)">タスクはありません</p>' 
                : dayTasks.map(t => {
                    const timePart = (t.deadline && t.deadline.startsWith(dateStr) && t.deadline.includes('T')) ? t.deadline.split('T')[1] : '';
                    const extraBadge = (t.extraDates && t.extraDates.includes(dateStr)) ? ' <span style="font-size:10px; background:#eee; padding:2px 4px; border-radius:4px;">追加日</span>' : '';
                    return `<div class="task-item" style="padding:10px; margin-bottom:8px;">${t.completed?'✓ ':'🟢 '}${t.title} <span style="font-size: 0.8em; color: gray;">${timePart}</span>${extraBadge}</div>`;
                }).join('');
            
            taskHtml += `<button class="btn-outline full-width" style="margin-top:16px;" onclick="openModal(null, '${dateStr}')">＋ ${calDate.getMonth()+1}月${i}日にタスクを追加</button>`;
            document.getElementById('calendar-tasks').innerHTML = `<h3>${calDate.getMonth()+1}月${i}日の予定</h3><br>` + taskHtml;
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
        currentStatStatus = null;
        detailsCard.classList.add('hidden');
        cardActive.style.borderColor = 'transparent';
        cardCompleted.style.borderColor = 'transparent';
        cardActive.style.backgroundColor = 'var(--card-bg)';
        cardCompleted.style.backgroundColor = 'var(--card-bg)';
        return;
    }
    
    currentStatStatus = status;
    detailsCard.classList.remove('hidden');
    
    if (status === 'active') {
        cardActive.style.borderColor = '#007aff';
        cardActive.style.backgroundColor = 'rgba(0, 122, 255, 0.05)';
        cardCompleted.style.borderColor = 'transparent';
        cardCompleted.style.backgroundColor = 'var(--card-bg)';
    } else {
        cardCompleted.style.borderColor = '#34c759';
        cardCompleted.style.backgroundColor = 'rgba(52, 199, 89, 0.05)';
        cardActive.style.borderColor = 'transparent';
        cardActive.style.backgroundColor = 'var(--card-bg)';
    }
    
    document.getElementById('stat-details-title').innerText = status === 'active' ? '未完了タスクの内訳' : '完了済みタスクの内訳';
    
    renderStatDetails();
}

function renderStatDetails() {
    const container = document.getElementById('stat-details-content');
    container.innerHTML = '';
    
    const groupBy = document.getElementById('stat-group-by').value;
    
    const filtered = currentTasks.filter(t => currentStatStatus === 'active' ? !t.completed : t.completed);
    
    if (filtered.length === 0) {
        container.innerHTML = '<p style="color:var(--text-secondary); font-size: 14px; text-align: center; padding: 12px 0;">該当するタスクがありません。</p>';
        return;
    }
    
    const groups = {};
    filtered.forEach(t => {
        let key = '';
        if (groupBy === 'category') {
            key = t.category ? t.category : '未分類';
        } else if (groupBy === 'date') {
            key = t.deadline ? t.deadline.split('T')[0] : '日付未設定';
        }
        
        if (!groups[key]) groups[key] = [];
        groups[key].push(t);
    });
    
    const sortedKeys = Object.keys(groups).sort((a, b) => {
        if (a === '日付未設定' || a === '未分類') return 1;
        if (b === '日付未設定' || b === '未分類') return -1;
        return a.localeCompare(b);
    });
    
    let html = '';
    sortedKeys.forEach(key => {
        html += `<div class="stat-group">
            <h4 style="margin: 16px 0 8px 0; font-size: 13px; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); padding-bottom: 4px; display: flex; justify-content: space-between;">
                <span>${key === '日付未設定' || key === '未分類' ? key : (groupBy === 'date' ? '📅 ' + key : '📁 ' + key)}</span>
                <span style="font-weight: normal; background: var(--bg-color); padding: 2px 8px; border-radius: 12px; font-size: 11px;">${groups[key].length}件</span>
            </h4>
            <div style="display: flex; flex-direction: column; gap: 8px;">`;
            
        groups[key].forEach(t => {
            const extraInfo = groupBy === 'date' ? (t.category ? `📁 ${t.category}` : '') : (t.deadline ? `📅 ${t.deadline.replace('T', ' ')}` : '');
            
            html += `
                <div style="font-size: 14px; display: flex; flex-direction: column; background: var(--bg-color); padding: 10px 12px; border-radius: 8px; border-left: 3px solid ${t.completed ? '#34c759' : '#007aff'};">
                    <span style="font-weight: 600; ${t.completed ? 'text-decoration: line-through; color: var(--text-secondary);' : ''}">${t.title}</span>
                    ${extraInfo ? `<span style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">${extraInfo}</span>` : ''}
                </div>
            `;
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

    if (currentStatStatus) {
        renderStatDetails();
    }
}
