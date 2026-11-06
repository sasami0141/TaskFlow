// TaskFlow Main Logic & Notification Handler - v5

document.addEventListener('DOMContentLoaded', () => {
  // Service Worker Registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker Registered', reg))
      .catch(err => console.error('Service Worker Registration Failed', err));
  }

  // Request Notification Permission
  requestNotificationPermission();

  // Load and Render Tasks
  loadTasks();

  // Modal Setup & Event Listeners
  const addTaskBtn = document.getElementById('add-task-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const taskModal = document.getElementById('task-modal');
  const taskForm = document.getElementById('task-form');

  if (addTaskBtn && taskModal) {
    addTaskBtn.addEventListener('click', () => {
      taskModal.classList.remove('hidden');
    });
  }

  if (cancelBtn && taskModal) {
    cancelBtn.addEventListener('click', () => {
      taskModal.classList.add('hidden');
    });
  }

  if (taskForm) {
    taskForm.addEventListener('submit', (e) => {
      e.preventDefault();
      // Handle task creation
      const title = document.getElementById('task-title-input').value;
      const dueDate = document.getElementById('task-due-date').value;
      const reminderDays = document.getElementById('task-reminder').value;

      const newTask = {
        id: Date.now().toString(),
        title,
        dueDate,
        reminderDays,
        completed: false,
        createdAt: new Date().toISOString()
      };

      saveTask(newTask);
      taskForm.reset();
      taskModal.classList.add('hidden');
    });
  }
});

// Notification Permission
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }
  return false;
}

// Check & Send Task Notification
async function checkAndSendTaskNotification(task) {
  if (Notification.permission !== 'granted') return;
  if (!task.dueDate || task.completed || task.reminderDays === 'none') return;

  const targetReminderDays = parseInt(task.reminderDays, 10);
  const dueDate = new Date(task.dueDate);
  const now = new Date();
  
  dueDate.setHours(0, 0, 0, 0);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const diffTime = dueDate.getTime() - today.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === targetReminderDays) {
    const daysText = targetReminderDays === 0 ? '今日' : `あと${targetReminderDays}日`;
    const title = `【リマインダー】TaskFlow`;
    const options = {
      body: `「${task.title}」の期限は${daysText}です！`,
      icon: 'icon.png',
      badge: 'icon.png',
      tag: `task-reminder-${task.id}-${targetReminderDays}`,
      data: { url: location.href }
    };

    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      registration.showNotification(title, options);
    } else {
      new Notification(title, options);
    }
  }
}

function saveTask(task) {
  const tasks = JSON.parse(localStorage.getItem('taskflow_tasks') || '[]');
  tasks.push(task);
  localStorage.setItem('taskflow_tasks', JSON.stringify(tasks));
  checkAndSendTaskNotification(task);
  renderTasks();
}

function loadTasks() {
  renderTasks();
}

function renderTasks() {
  const taskList = document.getElementById('task-list');
  const emptyState = document.getElementById('empty-state');
  const tasks = JSON.parse(localStorage.getItem('taskflow_tasks') || '[]');

  if (!taskList) return;

  taskList.innerHTML = '';
  if (tasks.length === 0) {
    if (emptyState) emptyState.style.display = 'block';
  } else {
    if (emptyState) emptyState.style.display = 'none';
    tasks.forEach(task => {
      const li = document.createElement('li');
      li.className = `task-item ${task.completed ? 'completed' : ''}`;
      li.innerHTML = `<span>${task.title}</span>`;
      taskList.appendChild(li);
    });
  }
}
