const TASKFLOW_TIME_ZONE = 'Asia/Tokyo';
const TASKFLOW_TASKS_SHEET = 'tasks';
const TASKFLOW_NOTIFICATION_LOG_SHEET = '_notification_log';
const TASKFLOW_API_KEY_PROPERTY = 'TASKFLOW_API_KEY';
const TASKFLOW_TASK_HEADERS = [
  'id', 'title', 'startDate', 'deadline', 'deadlineAt', 'priority', 'recurring',
  'memo', 'completed', 'notificationMode', 'notificationAt', 'extraDates',
  'urls', 'images', 'subtasks', 'createdAt'
];

function doPost(e) {
  const expectedApiKey = PropertiesService.getScriptProperties().getProperty(TASKFLOW_API_KEY_PROPERTY);
  if (!expectedApiKey || !expectedApiKey.trim()) {
    return taskflowJsonResponse({ ok: false, error: 'API key is not configured.' });
  }

  let request;
  try {
    request = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '');
  } catch (error) {
    return taskflowJsonResponse({ ok: false, error: 'Invalid JSON request.' });
  }
  if (!request || typeof request.apiKey !== 'string' || request.apiKey !== expectedApiKey.trim()) {
    return taskflowJsonResponse({ ok: false, error: 'Unauthorized.' });
  }
  if (!Array.isArray(request.tasks) || request.tasks.some(function(task) {
    return !task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !task.id;
  })) {
    return taskflowJsonResponse({ ok: false, error: 'Invalid tasks array.' });
  }

  try {
    writeTaskSnapshot(request.tasks);
    return taskflowJsonResponse({ ok: true, taskCount: request.tasks.length });
  } catch (error) {
    console.error('TaskFlow snapshot write failed: ' + error.message);
    throw new Error('TaskFlow snapshot could not be saved.');
  }
}

function taskflowJsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function writeTaskSnapshot(tasks) {
  const rows = tasks.map(function(task) {
    return [
      taskflowTextCell(task.id),
      taskflowTextCell(task.title),
      taskflowTextCell(task.startDate),
      taskflowTextCell(task.deadline),
      taskflowTextCell(task.deadlineAt),
      taskflowTextCell(task.priority),
      taskflowTextCell(task.recurring),
      taskflowTextCell(task.memo),
      task.completed === true,
      taskflowTextCell(task.notificationMode || 'none'),
      taskflowTextCell(task.notificationAt),
      taskflowJsonCell(task.extraDates),
      taskflowJsonCell(task.urls),
      taskflowJsonCell(task.images),
      taskflowJsonCell(task.subtasks),
      taskflowTextCell(task.createdAt)
    ];
  });
  const values = [TASKFLOW_TASK_HEADERS].concat(rows);
  const spreadsheet = taskflowGetSpreadsheet();
  const sheet = spreadsheet.getSheetByName(TASKFLOW_TASKS_SHEET) ||
    spreadsheet.insertSheet(TASKFLOW_TASKS_SHEET);

  sheet.clearContents();
  const range = sheet.getRange(1, 1, values.length, TASKFLOW_TASK_HEADERS.length);
  range.setNumberFormat('@');
  range.setValues(values);
}

function taskflowGetSpreadsheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('This script must be bound to the TaskFlow spreadsheet.');
  return spreadsheet;
}

function taskflowTextCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (text.length > 49000) throw new Error('A task field exceeds the Google Sheets cell limit.');
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function taskflowJsonCell(value) {
  const json = JSON.stringify(value === undefined || value === null ? [] : value);
  if (json.length > 49000) throw new Error('A task field exceeds the Google Sheets cell limit.');
  return json;
}

function installTaskNotificationTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'scanTaskNotifications') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('scanTaskNotifications').timeBased().everyMinutes(5).create();
}

function scanTaskNotifications() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const spreadsheet = taskflowGetSpreadsheet();
    const taskSheet = spreadsheet.getSheetByName(TASKFLOW_TASKS_SHEET);
    if (!taskSheet || taskSheet.getLastRow() < 2) return;

    const values = taskSheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const tasks = values.slice(1).map(function(row) {
      return taskflowReadTask(row, headers);
    });
    const logSheet = spreadsheet.getSheetByName(TASKFLOW_NOTIFICATION_LOG_SHEET) ||
      spreadsheet.insertSheet(TASKFLOW_NOTIFICATION_LOG_SHEET);
    if (logSheet.getLastRow() === 0) logSheet.getRange(1, 1, 1, 2).setValues([['key', 'sentAt']]);
    const loggedKeys = new Set();
    if (logSheet.getLastRow() > 1) {
      logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 1).getValues().forEach(function(row) {
        loggedKeys.add(String(row[0]));
      });
    }

    const now = new Date();
    const due = [];
    tasks.forEach(function(task) {
      if (task.completed) return;
      const notice = taskflowGetEligibleNotice(task, now);
      if (notice && !loggedKeys.has(notice.key)) due.push(notice);
    });
    if (due.length === 0) return;

    const recipient = Session.getEffectiveUser().getEmail();
    if (!recipient) throw new Error('The trigger execution account email is unavailable.');
    const lines = due.map(function(notice) {
      const deadlineText = notice.deadline
        ? '（期限: ' + Utilities.formatDate(notice.deadline, TASKFLOW_TIME_ZONE, 'yyyy/MM/dd HH:mm') + '）'
        : '';
      return '・' + notice.title + deadlineText;
    });
    MailApp.sendEmail({
      to: recipient,
      subject: 'TaskFlowの期限リマインダー（' + Utilities.formatDate(now, TASKFLOW_TIME_ZONE, 'yyyy/MM/dd HH:mm') + '）',
      body: '未完了タスクのお知らせです。\n\n' + lines.join('\n')
    });

    const sentAt = now.toISOString();
    const logRows = due.map(function(notice) { return [notice.key, sentAt]; });
    logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, 2).setValues(logRows);
  } finally {
    lock.releaseLock();
  }
}

function taskflowReadTask(row, headers) {
  const values = {};
  headers.forEach(function(header, index) { values[header] = row[index]; });
  return {
    id: String(values.id || ''),
    title: String(values.title || '(タイトルなし)'),
    deadline: taskflowParseTaskDeadline(values.deadlineAt, values.deadline),
    completed: values.completed === true || String(values.completed).toLowerCase() === 'true',
    notificationMode: String(values.notificationMode || 'none'),
    notificationAt: String(values.notificationAt || '')
  };
}

function taskflowParseTaskDeadline(deadlineAt, deadline) {
  if (deadlineAt) {
    const exactDate = new Date(deadlineAt);
    return Number.isNaN(exactDate.getTime()) ? null : exactDate;
  }
  if (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline)) return null;
  try {
    return Utilities.parseDate(deadline, TASKFLOW_TIME_ZONE, "yyyy-MM-dd'T'HH:mm");
  } catch (error) {
    return null;
  }
}

function taskflowGetEligibleNotice(task, now) {
  const mode = task.notificationMode;
  if (mode === 'custom') {
    const scheduledAt = new Date(task.notificationAt);
    if (!task.notificationAt || Number.isNaN(scheduledAt.getTime()) || now < scheduledAt) return null;
    return {
      key: JSON.stringify([task.id, mode, scheduledAt.toISOString()]),
      title: task.title,
      deadline: null
    };
  }

  if (mode !== 'within24h' && mode !== 'deadlineMorning') return null;
  const deadline = task.deadline;
  if (!deadline || now > deadline) return null;
  if (mode === 'within24h' && now < new Date(deadline.getTime() - 24 * 60 * 60 * 1000)) return null;
  if (mode === 'deadlineMorning') {
    if (Utilities.formatDate(now, TASKFLOW_TIME_ZONE, 'yyyy-MM-dd') !==
        Utilities.formatDate(deadline, TASKFLOW_TIME_ZONE, 'yyyy-MM-dd') ||
        Number(Utilities.formatDate(now, TASKFLOW_TIME_ZONE, 'H')) < 7) return null;
  }
  return {
    key: JSON.stringify([task.id, mode, deadline.toISOString()]),
    title: task.title,
    deadline: deadline
  };
}
