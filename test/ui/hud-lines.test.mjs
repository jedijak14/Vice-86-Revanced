// The two lines the cluster gained with the body and the radio: vitals, which stays dark until
// something is actually wrong, and the dial, which says what the car is playing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHudModel, updateHudModel } from '../../web/src/ui/hud-model.js';

const tick = (input) => {
  const model = createHudModel();
  updateHudModel(model, input, 'kmh', 0);
  return model;
};

test('a whole, dry walker shows no vitals at all', () => {
  const m = tick({ foot: { onFoot: true, health: 1, oxygen: 1, stamina: 1 } });
  assert.equal(m.vitals, '', 'nothing missing, nothing said');
});

test('a wound, a dive and the sea each put a number on the row', () => {
  const hurt = tick({ foot: { onFoot: true, health: 0.42, oxygen: 1 } });
  assert.match(hurt.vitals, /42%/, 'the wound is a percentage');
  const dive = tick({ foot: { onFoot: true, health: 1, oxygen: 0.6, submerged: true, swimming: true } });
  assert.match(dive.vitals, /O₂ 60%/, 'and the dive is air');
  assert.match(dive.vitals, /under/, 'and it says he is under');
  const swim = tick({ foot: { onFoot: true, health: 1, oxygen: 1, swimming: true } });
  assert.match(swim.vitals, /swimming/, 'surfaced but swimming still names it');
  const down = tick({ foot: { onFoot: true, dead: true } });
  assert.match(down.vitals, /down/, 'and the last line is the last line');
});

test('the dial row is empty when the radio is off, and full when it is on', () => {
  assert.equal(tick({ radio: null }).radio, '');
  const on = tick({ radio: { station: 'KBAY 89.1', title: 'Rain on Canvas' } });
  assert.equal(on.radio, 'KBAY 89.1 · Rain on Canvas');
  const noTitle = tick({ radio: { station: 'Bayou FM', title: '' } });
  assert.equal(noTitle.radio, 'Bayou FM', 'a station with no title yet is still a station');
});
