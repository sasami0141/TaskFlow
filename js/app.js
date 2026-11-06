// TaskFlow Main Logic & Notification Handler

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

function loadTasks() {
  // Simple local storage loading logic placeholder
  const tasks = JSON.parse(localStorage.getItem('taskflow_tasks') || '[]');
  tasks.forEach(task => checkAndSendTaskNotification(task));
}
