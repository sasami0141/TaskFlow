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
