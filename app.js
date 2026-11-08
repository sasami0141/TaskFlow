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
        request.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
        request.onerror = (e) => reject(e.target.error);
    });
}
function getDB() { return dbInstance; }
function generateId() { return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9); }

function saveTask(task) {
    const db = getDB();
    if(!task.id) task.id = generateId();
    if(!task.createdAt) task.createdAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').put(task);
        tx.oncomplete = () => resolve(task);
    });
}
function getAllTasks() {
    const db = getDB();
    return new Promise((resolve) => {
        const tx = db.transaction('tasks', 'readonly');
        const req = tx.objectStore('tasks').getAll();
        req.onsuccess = () => resolve(req.result);
    });
}
function deleteTask(id) {
    const db = getDB();
    return new Promise((resolve) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').delete(id);
        tx.oncomplete = () => resolve();
    });
}
async function toggleTaskStatus(task) {
    task.completed = !task.completed;
    return saveTask(task);
}

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
        });
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) { refreshing = true; window.location.reload(); }
        });
    }
}
function fetchAppVersion() {
    fetch('sw.js', {cache: "no-store"}).then(res => res.text()).then(text => {
        const match = text.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
        if (match && match[1]) {
            document.getElementById('app-version-info').innerText = `現在のバージョン: ${match[1].replace('taskflow-cache-', '')}`;
        }
    }).catch(() => {});
}

let currentTasks = [];

document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    setupUI();
    await loadTasks();
    setupServiceWorker();
    fetchAppVersion();
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
        });
    });

    document.getElementById('fab-add').addEventListener('click', () => openModal());
    document.getElementById('btn-cancel').addEventListener('click', () => document.getElementById('task-modal').classList.add('hidden'));
    
    document.getElementById('btn-save').addEventListener('click', async () => {
        const title = document.getElementById('task-title').value;
        if(!title) return alert('タスク名を入力してください');
        const task = {
            id: document.getElementById('task-id').value || null,
            title, 
            startDate: document.getElementById('task-start').value,
            deadline: document.getElementById('task-deadline').value,
            priority: document.getElementById('task-priority').value,
            completed: document.getElementById('task-id').dataset.completed === 'true',
            extraDates: [], urls: [], images: [], subtasks: []
        };
        await saveTask(task);
        document.getElementById('task-modal').classList.add('hidden');
        loadTasks();
    });
}

function openModal(task = null) {
    document.getElementById('modal-title').innerText = task ? '詳細を編集' : '新しいタスク';
    document.getElementById('task-id').value = task ? task.id : '';
    document.getElementById('task-id').dataset.completed = task ? task.completed : 'false';
    document.getElementById('task-title').value = task ? task.title : '';
    document.getElementById('task-start').value = task && task.startDate ? task.startDate : '';
    document.getElementById('task-deadline').value = task ? task.deadline : '';
    document.getElementById('task-modal').classList.remove('hidden');
}

async function loadTasks() { currentTasks = await getAllTasks(); renderTasks(); }

function applySwipeToDelete(wrapperEl, taskItemEl, task) {
    let startX = 0, currentX = 0, isDragging = false, lastMoveX = 0;
    const startDrag = (e) => {
        if (e.target.closest('input')) return;
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
        if (e.target.closest('input')) return;
        openModal(task);
    });
}

function renderTasks() {
    const list = document.getElementById('task-list');
    list.innerHTML = '';
    
    if(currentTasks.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
    } else {
        document.getElementById('empty-state').classList.add('hidden');
        currentTasks.forEach(task => {
            const li = document.createElement('li');
            li.className = `task-item-wrapper ${task.completed ? 'completed' : ''}`;
            
            // ボタンが存在しない新しいレイアウト
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
                            </div>
                        </div>
                    </div>
                </div>`;
            
            const taskItemEl = li.querySelector('.task-item');
            
            taskItemEl.querySelector('.inline-edit-title').addEventListener('change', async e => { task.title = e.target.value; await saveTask(task); });
            taskItemEl.querySelector('.inline-edit-title').addEventListener('click', e => e.stopPropagation());
            
            taskItemEl.querySelector('.task-chk').addEventListener('change', async (e) => {
                await toggleTaskStatus(task); loadTasks();
            });

            applySwipeToDelete(li, taskItemEl, task);
            list.appendChild(li);
        });
    }
}
