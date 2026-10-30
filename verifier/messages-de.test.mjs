import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MESSAGES_DE,textDe} from './messages-de.mjs';

test('German defect texts state the rule as the pinned rule set does',()=>{
 assert.match(textDe('BR-AE-02'),/BT-31.*BT-32.*BT-63.*BT-48.*BT-47/);
 assert.match(textDe('BR-S-02'),/BT-31.*BT-32.*BT-63/);
 assert.match(textDe('BR-DE-16'),/S, Z, E, AE, K, G, L oder M/);
 assert.equal(MESSAGES_DE['BR-CO-25'],undefined,'BR-CO-25 does not exist in EN16931 UBL 1.3.16');
 for(const code of ['BR-01','BR-03','BR-04','BR-05','BR-08','BR-09','BR-10','BR-11','BR-12','BR-13','BR-14','BR-15','BR-CO-14','BR-CO-17','BR-CO-26','BR-S-05'])
  assert.ok(MESSAGES_DE[code],`German text for ${code}`);
});

test('rules without a German text are marked as KoSIT original text, never shown as if translated',()=>{
 assert.equal(textDe('BR-XX-99','[BR-XX-99]-Some rule text'),'Regel BR-XX-99 (Originaltext KoSIT, englisch): Some rule text');
 assert.match(textDe('cvc-complex-type.2.4.a','cvc-complex-type.2.4.a: Invalid content was found'),/^Die XML-Datei entspricht nicht dem UBL-2\.1-Schema \(cvc-complex-type\.2\.4\.a\).*Invalid content/);
 assert.equal(textDe('BR-DE-99','[BR-DE-99] Deutscher Text.'),'Deutscher Text.');
});
