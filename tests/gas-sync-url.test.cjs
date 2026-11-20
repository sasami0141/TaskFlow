const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appCore = fs.readFileSync(path.join(__dirname, '..', 'js', 'app_core.js'), 'utf8');
const validatorSource = appCore.match(/function isValidGasSyncUrl\(value\) \{[\s\S]*?\n\}/);
assert.ok(validatorSource, 'GAS URL validator must exist in app_core.js');
const isValidGasSyncUrl = vm.runInNewContext(`(${validatorSource[0]})`, { URL });

test('accepts canonical and account-indexed GAS web app URLs', () => {
    assert.equal(isValidGasSyncUrl('https://script.google.com/macros/s/DEPLOYMENT_ID/exec'), true);
    assert.equal(isValidGasSyncUrl('https://script.google.com/macros/u/0/s/DEPLOYMENT_ID/exec'), true);
    assert.equal(isValidGasSyncUrl('https://script.google.com/macros/u/12/s/DEPLOYMENT_ID/exec?authuser=12'), true);
});

test('rejects URLs outside the GAS HTTPS /exec endpoint', () => {
    assert.equal(isValidGasSyncUrl('http://script.google.com/macros/s/DEPLOYMENT_ID/exec'), false);
    assert.equal(isValidGasSyncUrl('https://example.com/macros/s/DEPLOYMENT_ID/exec'), false);
    assert.equal(isValidGasSyncUrl('https://script.google.com/macros/s/DEPLOYMENT_ID/dev'), false);
    assert.equal(isValidGasSyncUrl('https://script.google.com/macros/u/x/s/DEPLOYMENT_ID/exec'), false);
});
