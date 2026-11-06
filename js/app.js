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

// --- Task Manager Module ---
function generateId() { return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9); }

function calculateDate(baseDateStr, type, amount) {
    const d = baseDateStr ? new Date(baseDateStr) : new Date();
    if (type === 'days') {
        d.setDate(d.getDate() + amount);
    } else if (type === 'weeks') {
        d.setDate(d.getDate() + (amount * 7));
    } else if (type === 'months') {
        const currentDay = d.getDate();
        d.setMonth(d.getMonth() + amount);
        if (d.getDate() !== currentDay) d.setDate(0); 
    }
    const tzOffset = d.getTimezoneOffset() * 60000;
    return (new Date(d - tzOffset)).toISOString().slice(0, 10);
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
            // 曜日指定の次回計算
            let d = task.deadline ? new Date(task.deadline) : new Date();
            d.setDate(d.getDate() + 1); // 翌日以降で検索
            while(d.getDay() !== weekdayMap[task.recurring]) {
                d.setDate(d.getDate() + 1);
            }
            const tzOffset = d.getTimezoneOffset() * 60000;
            newDateStr = (new Date(d - tzOffset)).toISOString().slice(0, 10);
        }
        
        const nextTask = { ...task, id: generateId(), completed: false, deadline: newDateStr, subtasks: task.subtasks.map(st => ({...st, completed: false})) };
        await saveTask(nextTask);
    }
    return saveTask(task);
}

// --- Backup Module ---
async function backupData() {
    const tasks = await getAllTasks();
    const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TaskFlow_Backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function restoreData(file) {
    const text = await file.text();
    const tasks = JSON.parse(text);
    const currentTasks = await getAllTasks();
    for (const t of currentTasks) await deleteTask(t.id);
    for (const t of tasks) await saveTask(t);
}

// --- Application Logic ---
let currentTasks = [];
let calDate = new Date();

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        setupUI();
        await loadTasks();
        if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.log('SW Registration skipped in local file mode.'));
    } catch(err) {
        alert("データベースの初期化に失敗しました。ローカル環境の設定が原因の可能性があります。");
        console.error(err);
    }
});

function setupUI() {
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

    const modal = document.getElementById('task-modal');
    document.getElementById('fab-add').addEventListener('click', () => openModal());
    document.getElementById('btn-cancel').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('modal-overlay').addEventListener('click', () => modal.classList.add('hidden'));
    
    // Quick Dates
    document.querySelectorAll('.btn-quick').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const days = e.target.dataset.days;
            const months = e.target.dataset.months;
            const today = new Date().toISOString().slice(0, 10);
            const input = document.getElementById('task-deadline');
            const baseDate = input.value || today;
            if(days) input.value = calculateDate(baseDate, 'days', parseInt(days));
            if(months) input.value = calculateDate(baseDate, 'months', parseInt(months));
        });
    });

    // 相対日付の手入力適用
    document.getElementById('btn-apply-rel').addEventListener('click', () => {
        const amount = parseInt(document.getElementById('rel-amount').value);
        if(isNaN(amount) || amount < 1) return alert('日数を正しく入力してください');
        const unit = document.getElementById('rel-unit').value;
        const input = document.getElementById('task-deadline');
        const baseDate = input.value || new Date().toISOString().slice(0, 10);
        input.value = calculateDate(baseDate, unit, amount);
    });

    document.getElementById('btn-add-subtask').addEventListener('click', () => {
        const container = document.getElementById('subtasks-container');
        const id = generateId();
        const div = document.createElement('div');
        div.className = 'subtask-item';
        div.innerHTML = `<input type="text" placeholder="サブタスクを入力..." data-id="${id}" class="st-input"><button type="button" class="btn-st-del">×</button>`;
        div.querySelector('.btn-st-del').onclick = () => div.remove();
        container.appendChild(div);
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
            priority: document.getElementById('task-priority').value,
            category: document.getElementById('task-category').value,
            recurring: document.getElementById('task-recurring').value,
            memo: document.getElementById('task-memo').value,
            completed: document.getElementById('task-id').dataset.completed === 'true',
            subtasks
        };
        await saveTask(task);
        modal.classList.add('hidden');
        loadTasks();
    });

    document.getElementById('search-input').addEventListener('input', renderTasks);
    document.getElementById('filter-status').addEventListener('change', renderTasks);
    document.getElementById('sort-select').addEventListener('change', renderTasks);

    document.getElementById('btn-backup').addEventListener('click', backupData);
    document.getElementById('input-restore').addEventListener('change', async (e) => {
        if(e.target.files.length > 0) {
            await restoreData(e.target.files[0]);
            loadTasks();
            alert('復元が完了しました');
        }
    });

    // 全データ消去
    document.getElementById('btn-clear-all').addEventListener('click', async () => {
        if(confirm('⚠️ 本当にすべてのデータを消去しますか？\nこの操作は取り消せません。')) {
            await clearAllData();
            await loadTasks();
            alert('すべてのデータを消去しました。');
        }
    });
}

function openModal(task = null) {
    document.getElementById('modal-title').innerText = task ? 'タスクを編集' : '新しいタスク';
    document.getElementById('task-id').value = task ? task.id : '';
    document.getElementById('task-id').dataset.completed = task ? task.completed : 'false';
    document.getElementById('task-title').value = task ? task.title : '';
    document.getElementById('task-deadline').value = task ? task.deadline : '';
    document.getElementById('task-priority').value = task ? task.priority : '2';
    document.getElementById('task-category').value = task ? task.category : '';
    document.getElementById('task-recurring').value = task ? task.recurring : 'none';
    document.getElementById('task-memo').value = task ? task.memo : '';
    document.getElementById('rel-amount').value = '';
    
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

    if(search) filtered = filtered.filter(t => t.title.toLowerCase().includes(search) || (t.category||'').toLowerCase().includes(search));
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
            
            // ホーム画面表示用のサブタスクHTML
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
            
            li.innerHTML = `
                <div class="task-header">
                    <input type="checkbox" class="task-chk" ${task.completed ? 'checked' : ''}>
                    <div class="task-content">
                        <div class="task-title">${task.title}</div>
                        <div class="task-meta">
                            ${task.deadline ? `<span>📅 ${task.deadline}</span>` : ''}
                            ${task.category ? `<span>📁 ${task.category}</span>` : ''}
                            <span>${priorityIcon}</span>
                        </div>
                        ${subtasksHtml}
                    </div>
                </div>
                <div class="task-actions">
                    <button class="btn-text btn-edit">編集</button>
                    <button class="btn-text danger btn-del">削除</button>
                </div>
            `;
            
            // サブタスクのチェックボックス処理
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

            // メインタスクの遅延完了＆取り消し処理
            const mainChk = li.querySelector('.task-chk');
            mainChk.addEventListener('change', async (e) => {
                // 連打による複数回処理をブロック
                if (li.dataset.processing) {
                    e.preventDefault();
                    e.target.checked = !e.target.checked; 
                    return;
                }

                // 「未完了」を「完了」にする時の遅延処理
                if (e.target.checked && !task.completed) {
                    li.dataset.processing = "true";
                    li.classList.add('completing');
                    
                    const btnUndo = document.createElement('button');
                    btnUndo.className = 'btn-text btn-undo';
                    btnUndo.innerText = '↺ 取り消し';
                    li.querySelector('.task-actions').prepend(btnUndo);

                    const timeoutId = setTimeout(async () => {
                        await toggleTaskStatus(task);
                        loadTasks();
                    }, 1500); // 1.5秒待機

                    // 取り消しボタンの処理
                    btnUndo.addEventListener('click', () => {
                        clearTimeout(timeoutId);
                        li.dataset.processing = "";
                        li.classList.remove('completing');
                        e.target.checked = false;
                        btnUndo.remove();
                    });
                } else {
                    // すでに完了しているものを未完了に戻す場合は即時反映
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

function renderCalendar() {
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
        const hasTask = currentTasks.some(t => t.deadline === dateStr && !t.completed);
        const div = document.createElement('div');
        div.className = `cal-day ${hasTask ? 'has-task' : ''}`;
        div.innerText = i;
        div.onclick = () => {
            const dayTasks = currentTasks.filter(t => t.deadline === dateStr);
            const taskHtml = dayTasks.length === 0 
                ? '<p style="color:var(--text-secondary)">タスクはありません</p>' 
                : dayTasks.map(t => `<div class="task-item" style="padding:10px; margin-bottom:8px;">${t.completed?'✓ ':'🟢 '}${t.title}</div>`).join('');
            document.getElementById('calendar-tasks').innerHTML = `<h3>${calDate.getMonth()+1}月${i}日の予定</h3><br>` + taskHtml;
        };
        grid.appendChild(div);
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
