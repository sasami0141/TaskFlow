const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appCore = fs.readFileSync(path.join(__dirname, '..', 'js', 'app_core.js'), 'utf8');
const helperSource = appCore.match(/function getRecentTasksByStatus\(tasks, status, limit = 10\) \{[\s\S]*?\n\}/);
assert.ok(helperSource, 'Recent statistics task helper must exist');
const getRecentTasksByStatus = vm.runInNewContext(`(${helperSource[0]})`);

test('filters active and completed tasks independently', () => {
    const tasks = [
        { id: 'a', title: 'Active', completed: false, createdAt: '2026-11-01T00:00:00Z' },
        { id: 'b', title: 'Done', completed: true, createdAt: '2026-11-02T00:00:00Z' }
    ];

    assert.deepEqual(getRecentTasksByStatus(tasks, 'active').map(task => task.id), ['a']);
    assert.deepEqual(getRecentTasksByStatus(tasks, 'completed').map(task => task.id), ['b']);
});

test('uses descending createdAt and limits results to ten', () => {
    const tasks = Array.from({ length: 12 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        completed: true,
        createdAt: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00Z`
    }));

    const recent = getRecentTasksByStatus(tasks, 'completed');
    assert.equal(recent.length, 10);
    assert.equal(recent[0].id, 'task-11');
    assert.equal(recent[9].id, 'task-2');
});

test('uses id and title as stable tie-breakers for missing or invalid timestamps', () => {
    const tasks = [
        { id: 'c', title: 'Third', completed: false },
        { id: 'b', title: 'Second', completed: false, createdAt: 'invalid' },
        { id: 'a', title: 'First', completed: false, createdAt: 'invalid' }
    ];

    assert.deepEqual(
        getRecentTasksByStatus(tasks, 'active').map(task => task.id),
        ['a', 'b', 'c']
    );
});

test('statistics markup provides accessible status buttons and an expandable result panel', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    assert.match(html, /id="card-stat-active"[^>]*data-stat-status="active"[^>]*aria-expanded="false"[^>]*aria-controls="stats-task-panel"/);
    assert.match(html, /id="card-stat-completed"[^>]*data-stat-status="completed"[^>]*aria-expanded="false"[^>]*aria-controls="stats-task-panel"/);
    assert.match(html, /id="stats-task-panel"[^>]*role="region"/);
    assert.match(html, /id="stats-task-list"/);
});

test('email notifications do not require a browser notification permission control', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    assert.doesNotMatch(html, /btn-request-notify|通知を許可する/);
    assert.doesNotMatch(appCore, /btn-request-notify|Notification\.requestPermission/);
});

test('PWA cache and script versions stay in sync', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    const scriptVersion = html.match(/js\/app_core\.js\?v=(\d+)/);
    const cacheName = sw.match(/const CACHE_NAME = 'v-(\d+)';/);

    assert.ok(scriptVersion, 'index.html must include a versioned app_core.js URL');
    assert.ok(cacheName, 'sw.js must include a numeric cache version');
    assert.equal(scriptVersion[1], cacheName[1], 'app_core.js and CACHE_NAME must use the same version');
    assert.match(sw, new RegExp(`\\.\\/js\\/app_core\\.js\\?v=${scriptVersion[1]}`));
});
test('automatic sync allows any online network and pauses only while offline', () => {
    const helperSource = appCore.match(/function isTaskSyncNetworkAvailable\(networkNavigator\) \{[\s\S]*?\n\}/);
    assert.ok(helperSource, 'Network availability helper must exist');
    const isTaskSyncNetworkAvailable = vm.runInNewContext(`(${helperSource[0]})`);

    assert.equal(isTaskSyncNetworkAvailable({ onLine: true, connection: { type: 'wifi' } }), true);
    assert.equal(isTaskSyncNetworkAvailable({ onLine: true, connection: { type: 'ethernet' } }), true);
    assert.equal(isTaskSyncNetworkAvailable({ onLine: true, connection: { type: 'cellular' } }), true);
    assert.equal(isTaskSyncNetworkAvailable({ onLine: true, connection: { type: 'unknown' } }), true);
    assert.equal(isTaskSyncNetworkAvailable({ onLine: true }), true);
    assert.equal(isTaskSyncNetworkAvailable({ onLine: false }), false);
    assert.equal(isTaskSyncNetworkAvailable(null), false);
});
test('scheduling a saved task syncs automatically on cellular or unknown network types', () => {
    const availabilitySource = appCore.match(/function isTaskSyncNetworkAvailable\(networkNavigator\) \{[\s\S]*?\n\}/);
    const scheduleSource = appCore.match(/function scheduleTaskSync\(\) \{[\s\S]*?\n\}/);
    assert.ok(scheduleSource, 'Task sync scheduler must exist');

    for (const type of ['cellular', 'unknown']) {
        let callback;
        let syncCalls = 0;
        const context = {
            navigator: { onLine: true, connection: { type } },
            taskSyncTimer: null,
            taskSyncPending: false,
            getGasSyncUrl: () => 'https://script.google.com/macros/s/test/exec',
            getGasSyncApiKey: () => 'api-key',
            isValidGasSyncUrl: () => true,
            isTaskSyncNetworkAvailable: vm.runInNewContext(`(${availabilitySource[0]})`),
            stopTaskSyncRetry() {},
            clearTimeout() {},
            setTimeout(next, delay) {
                assert.equal(delay, 300);
                callback = next;
                return 1;
            },
            syncTasksToGas: () => {
                syncCalls++;
            }
        };

        vm.runInNewContext(scheduleSource[0], context);
        context.scheduleTaskSync();
        assert.equal(typeof callback, 'function');
        callback();
        assert.equal(syncCalls, 1);
    }
});
test('pending GAS sync retries when any network becomes available without a network change event', () => {
    const retrySource = appCore.match(/function startTaskSyncRetry\(\) \{[\s\S]*?\n\}/);
    const availabilitySource = appCore.match(/function isTaskSyncNetworkAvailable\(networkNavigator\) \{[\s\S]*?\n\}/);
    assert.ok(retrySource, 'Pending sync retry timer must exist');
    let retryCallback;
    let retryDelay;
    let scheduleTaskSyncCalls = 0;
    const context = {
        navigator: { onLine: false },
        taskSyncRetryTimer: null,
        taskSyncPending: true,
        setInterval(callback, delay) {
            retryCallback = callback;
            retryDelay = delay;
            return 1;
        },
        scheduleTaskSync: () => {
            scheduleTaskSyncCalls++;
        }
    };

    vm.runInNewContext(`${availabilitySource[0]}; ${retrySource[0]}; startTaskSyncRetry();`, context);
    assert.equal(retryDelay, 30000);
    retryCallback();
    assert.equal(scheduleTaskSyncCalls, 0);
    context.navigator.onLine = true;
    retryCallback();
    assert.equal(scheduleTaskSyncCalls, 1);
});

test('pending GAS sync retry does not schedule while offline', () => {
    const retrySource = appCore.match(/function startTaskSyncRetry\(\) \{[\s\S]*?\n\}/);
    const availabilitySource = appCore.match(/function isTaskSyncNetworkAvailable\(networkNavigator\) \{[\s\S]*?\n\}/);
    assert.ok(retrySource, 'Pending sync retry timer must exist');
    let retryCallback;
    let scheduleTaskSyncCalls = 0;
    const context = {
        navigator: { onLine: false },
        taskSyncRetryTimer: null,
        taskSyncPending: true,
        setInterval(callback) {
            retryCallback = callback;
            return 1;
        },
        scheduleTaskSync: () => {
            scheduleTaskSyncCalls++;
        }
    };

    vm.runInNewContext(`${availabilitySource[0]}; ${retrySource[0]}; startTaskSyncRetry();`, context);
    retryCallback();
    assert.equal(scheduleTaskSyncCalls, 0);
});

test('task persistence schedules automatic sync after saving locally', () => {
    assert.match(appCore, /tx\.oncomplete = \(\) => \{\s*resolve\(task\);\s*scheduleTaskSync\(\);\s*\};/);
});

test('settings expose a manual sync action as an optional fallback', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    assert.match(html, /id="btn-manual-gas-sync"/);
    assert.match(html, /タスクの追加・変更・削除時に自動同期します/);
    assert.match(appCore, /getElementById\('btn-manual-gas-sync'\)\.addEventListener\('click', syncTasksManually\)/);
});
