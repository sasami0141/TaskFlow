const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const gasCode = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

function createSenderHarness(sender, aliases) {
    const sentMessages = [];
    const properties = {
        TASKFLOW_NOTIFICATION_FROM: sender
    };
    const context = {
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key => properties[key] || ''
            })
        },
        GmailApp: {
            getAliases: () => aliases,
            sendEmail: (...args) => sentMessages.push(args)
        }
    };
    vm.runInNewContext(gasCode, context);
    return { context, sentMessages };
}

test('sends from a configured Gmail alias', () => {
    const { context, sentMessages } = createSenderHarness('notifications@example.com', [
        'notifications@example.com'
    ]);

    context.taskflowSendNotification('recipient@example.com', 'Subject', 'Body');

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0][0], 'recipient@example.com');
    assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[0][3])), {
        from: 'notifications@example.com'
    });
});

test('uses the trigger account when no sender alias is configured', () => {
    const { context, sentMessages } = createSenderHarness('', []);

    context.taskflowSendNotification('recipient@example.com', 'Subject', 'Body');

    assert.equal(sentMessages.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[0][3])), {});
});

test('rejects sender addresses that are not configured Gmail aliases', () => {
    const { context, sentMessages } = createSenderHarness('other@example.com', [
        'notifications@example.com'
    ]);

    assert.throws(
        () => context.taskflowSendNotification('recipient@example.com', 'Subject', 'Body'),
        /must be a Gmail alias/
    );
    assert.equal(sentMessages.length, 0);
});
